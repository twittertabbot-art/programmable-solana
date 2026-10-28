// The "Collectible per buy" template: PDAs, decoders, instruction builders, art helpers.
// Pieces are pegged to the coin, the Unipeg rule: a wallet holds at most one piece per `unit`
// coins in its token account. A buy mints, a sell burns from the end of the wallet's list,
// the wallet orders its own list, and a piece moves only together with its coins.
import { AccountMeta, Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Reader, Writer, concat, discriminatorMatches } from "./borsh.js";
import { ACCOUNT_DISC, IX } from "./generated.js";
import { PROGRAMS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./constants.js";
import { pda } from "./pda.js";

export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/// The SlotHashes sysvar. The pieces a buy earns are decided by the hash of a block that
/// does not exist yet when the buy is made, read from here two or more slots later.
export const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
export const REVEAL_DELAY_SLOTS = 2;
export const BATCH = { EMPTY: 0, WAITING: 1, REVEALED: 2, EXPIRED: 3 } as const;
export const MAX_MINT_PER_CALL = 4;
export const MAX_PER_BUY_CAP = 5;
/// Pieces one `sendPieces` may move.
export const MAX_SEND = 4;
/// Burns the SDK puts in one `settle`. The program takes any number; this keeps the
/// transaction small. A wallet further above the peg is settled again by the watcher.
export const MAX_BURNS_PER_SETTLE = 6;
/// The most pieces, minted and waiting, one wallet may hold on one pool. A full wallet
/// earns nothing on a buy and cannot be sent more.
export const MAX_PIECES_PER_WALLET = 200;

// ---- the deposit: one approval for a buy that earns pieces ---------------------------------
//
// A buy may pay the rent of the pieces it earns as a DEPOSIT: a plain SOL transfer from the
// buyer to its own ticket, after the swap, in the buy transaction (`depositTransfer`). The
// deposit is whatever the ticket holds above its rent-exempt minimum. Anyone may then send
// `mintFor`, which mints the wallet's decided pieces into the wallet and pays its sender
// back, out of the deposit, exactly what it spent plus `KEEPER_FEE`. The wallet's own
// `mintPieces` takes from the deposit first too, and `withdrawDeposit` gives it the rest.

/// What `mint_for` pays its sender per call that mints, on top of what the sender spent.
export const KEEPER_FEE = 10_000n;
/// What Metaplex Core keeps in each asset it creates, on top of the rent (its create fee).
/// Measured on Core's mainnet binary. Core can change it; pass `coreFee` to override.
export const CORE_CREATE_FEE = 1_500_000n;
/// A ticket with an empty list, in bytes; each piece in the list adds 32.
export const TICKET_BASE_SIZE = 346;
/// Metaplex Core's own bytes in an asset with no plugins; the name and the URI follow.
export const CORE_ASSET_FIXED_SIZE = 75;
/// What a piece's URI adds to the collection's base address: "/p/", 32 hex, "/", 32 hex.
export const PIECE_URI_EXTRA = 68;

/// The rent-exempt minimum of an account of `dataLength` bytes, in lamports.
export type RentFn = (dataLength: number) => bigint;
/// The rent of a LOCAL validator and of LiteSVM, and of nothing else: 3,480 lamports per
/// byte-year at an exemption threshold of two years, 6,960 a byte, over the data and the 128
/// bytes of account overhead. Mainnet charges 5,080 a byte (5,080 per byte-year, threshold
/// 1.0): an empty account is 650,240 lamports there and 890,880 here, a 346-byte ticket
/// 2,407,920 against 3,299,040. Never size or read a deposit with this on a public cluster:
/// read the chain's rent once (`rentFrom`, or `HookpoolClient.rent()`, which keeps it for an
/// hour) and pass it on. This stays as the documented local default, for tests and rehearsals.
export const STANDARD_RENT: RentFn = (n) => BigInt(n + 128) * 6_960n;
/// How long a read of the chain's rent is kept: an hour. The rent changes only by a feature gate.
export const RENT_TTL_MS = 3_600_000;
/// The rent of the chain `connection` talks to: two reads, sent at once.
export async function rentFrom(connection: Connection): Promise<RentFn> {
  const [zero, one] = await Promise.all([connection.getMinimumBalanceForRentExemption(0), connection.getMinimumBalanceForRentExemption(1)]);
  const base = BigInt(zero), perByte = BigInt(one - zero);
  return (n) => base + perByte * BigInt(n);
}
/// A reader of the chain's rent that reads it once and keeps it for `ttlMs` (an hour by
/// default). The SDK client, a page and a server process each keep one. Callers that arrive
/// while the read is out share it; a read that fails is not kept, so the next call reads again.
export function rentReader(connection: Connection, ttlMs = RENT_TTL_MS): () => Promise<RentFn> {
  let kept: { rent: RentFn; at: number } | null = null;
  let inFlight: Promise<RentFn> | null = null;
  return () => {
    if (kept && Date.now() - kept.at < ttlMs) return Promise.resolve(kept.rent);
    if (!inFlight) {
      inFlight = rentFrom(connection).then(
        (rent) => { kept = { rent, at: Date.now() }; inFlight = null; return rent; },
        (e) => { inFlight = null; throw e; },
      );
    }
    return inFlight;
  };
}
const utf8Len = (s: string) => new TextEncoder().encode(s).length;
/// The size of a ticket whose list holds `pieces`.
export function ticketSpace(pieces: number): number { return TICKET_BASE_SIZE + 32 * pieces; }
/// The size of the Metaplex Core asset of piece number `number` of this collection.
export function pieceAssetSize(cfg: { name: string; uriBase: string }, number: number): number {
  return CORE_ASSET_FIXED_SIZE + utf8Len(`${cfg.name} #${number}`) + utf8Len(cfg.uriBase) + PIECE_URI_EXTRA;
}
/// The deposit of an account: the lamports it holds above the rent of its size, at the rent of
/// the chain it is on (`rentFrom`, `HookpoolClient.rent()`). There is no default: the local
/// validator's rent would understate a deposit on mainnet by 1,880 lamports a byte, 891,120 on
/// an empty ticket, and say "no deposit" where there is one.
export function depositOf(lamports: number | bigint, dataLength: number, rent: RentFn): bigint {
  if (typeof rent !== "function") throw new Error("depositOf needs the chain's rent: collectible.rentFrom(connection), or client.rent()");
  const d = BigInt(lamports) - rent(dataLength);
  return d > 0n ? d : 0n;
}
/// What `withdraw_deposit` pays the wallet now: everything its ticket holds above the rent of
/// the size the program first shrinks it to, exactly its list (`ticketSpace(ownedCount)`). A
/// ticket that an earlier version of the program left longer than its list gives the rent of
/// the bytes nobody uses back too. A ticket is never shorter than its list; one that were would
/// be read at its own length, as the program never grows it here. This is the wallet's deposit
/// as the wallet can take it, the number to show and to decide a withdraw on. What a mint can
/// use (`mint`, `mint_for`, a keeper's cost check) stays `depositOf` at the ticket's current
/// length: a mint does not shrink the ticket, it grows into the spare bytes first.
export function withdrawableDeposit(lamports: number | bigint, dataLength: number, ownedCount: number, rent: RentFn): bigint {
  if (!Number.isInteger(ownedCount) || ownedCount < 0) throw new Error("withdrawableDeposit needs the number of pieces in the ticket's list");
  return depositOf(lamports, Math.min(dataLength, ticketSpace(ownedCount)), rent);
}
/// The deposit in a wallet's ticket, as `withdraw_deposit` would pay it now
/// (`withdrawableDeposit`). 0n when the wallet has no ticket. Bytes that are not a ticket are
/// read at their own length (`depositOf`). The chain's rent is read (two reads) when it is not
/// given.
export async function ticketDeposit(connection: Connection, pool: PublicKey, user: PublicKey, rent?: RentFn): Promise<bigint> {
  const [info, r] = await Promise.all([connection.getAccountInfo(collectiblePda.ticket(pool, user)), rent ? Promise.resolve(rent) : rentFrom(connection)]);
  if (!info || info.data.length === 0) return 0n;
  let owned: number | null = null;
  try { owned = decodeTicket(new Uint8Array(info.data)).owned.length; } catch { owned = null; }
  return owned === null ? depositOf(info.lamports, info.data.length, r) : withdrawableDeposit(info.lamports, info.data.length, owned, r);
}

export interface MintDepositOptions {
  /// Metaplex Core's create fee per asset. Default `CORE_CREATE_FEE`.
  coreFee?: bigint;
}
/// The longest collection name and renderer address the program takes. The owner of a
/// collection that is not locked may change either, up to these, at any time.
export const MAX_COLLECTION_NAME = 24;
export const MAX_URI_BASE = 80;
/// The most digits a piece's number can have: it is a u32.
export const MAX_NUMBER_DIGITS = 10;
/// The size a deposit sizes a piece's asset at: the largest it can be when it is minted,
/// whenever that is. The number "#N" at ten digits, so pieces other wallets mint first never
/// make it longer. While the collection is not locked, its name and address at the longest
/// the owner may still change them to (`locked` absent counts as not locked); a locked
/// collection at its real name and address.
export function depositAssetSize(cfg: { name: string; uriBase: string; locked?: boolean }): number {
  const fixed = cfg.locked === true;
  const name = fixed ? utf8Len(cfg.name) : Math.max(utf8Len(cfg.name), MAX_COLLECTION_NAME);
  const uri = fixed ? utf8Len(cfg.uriBase) : Math.max(utf8Len(cfg.uriBase), MAX_URI_BASE);
  return CORE_ASSET_FIXED_SIZE + name + 2 + MAX_NUMBER_DIGITS + uri + PIECE_URI_EXTRA;
}
/// What the deposit must hold for `pieces` pieces of this collection to be minted by anyone,
/// whenever that happens: per piece the asset's rent at its largest (`depositAssetSize`),
/// Metaplex Core's fee, the 32 bytes the ticket grows by, and one `KEEPER_FEE` (a keeper is
/// paid once per call of up to four pieces, so this covers any way the pieces are minted).
/// What the mint does not use stays in the deposit for the next buy, or for
/// `withdrawDeposit`: about 0.0006 SOL a piece on a collection that is not locked. Given a
/// `Connection`, the chain's rent is read first. `minted` is no longer read; it stays in the
/// type so that every caller of the first version still compiles.
export function mintDepositFor(rent: RentFn, cfg: { name: string; uriBase: string; minted?: number; locked?: boolean }, pieces: number, opts?: MintDepositOptions): bigint;
export function mintDepositFor(connection: Connection, cfg: { name: string; uriBase: string; minted?: number; locked?: boolean }, pieces: number, opts?: MintDepositOptions): Promise<bigint>;
export function mintDepositFor(rentOrConn: RentFn | Connection, cfg: { name: string; uriBase: string; minted?: number; locked?: boolean }, pieces: number, opts: MintDepositOptions = {}): bigint | Promise<bigint> {
  if (typeof rentOrConn !== "function") return rentFrom(rentOrConn).then((r) => mintDepositFor(r, cfg, pieces, opts));
  const rent = rentOrConn;
  if (!Number.isInteger(pieces) || pieces <= 0) return 0n;
  const perPiece = rent(depositAssetSize(cfg)) + (opts.coreFee ?? CORE_CREATE_FEE) + (rent(32) - rent(0)) + KEEPER_FEE;
  return perPiece * BigInt(pieces);
}
/// The asset addresses a wallet's waiting pieces get when somebody mints them next: from
/// the ticket's `minted` index on, at most four (one mint makes up to four). The newest
/// first, `count` of them: the ones a sell removes first when a keeper minted them before
/// the sell landed. A sell that names them in its settle (a pegged coin: its reap) burns
/// them itself and gets their rent back; addresses that hold nothing are skipped.
export function nextAssets(pool: PublicKey, user: PublicKey, t: Ticket, count: number): PublicKey[] {
  const n = Math.min(t.pending, MAX_MINT_PER_CALL);
  const k = Math.max(0, Math.min(count, n));
  return Array.from({ length: k }, (_, i) => collectiblePda.asset(pool, user, t.minted + n - 1 - i));
}
/// The pieces a buy that pays out `amountOut` coins earns `ticket`'s wallet: one per `unit`,
/// at most `maxPerBuy`, within what the collection has left and the wallet's 200. An upper
/// bound: a ticket whose four batches are all taken earns nothing until it mints.
export function piecesEarned(cfg: Pick<CollectionConfig, "unit" | "maxPerBuy" | "maxSupply" | "live" | "reservedPending">, ticket: Ticket | null, amountOut: bigint): number {
  if (cfg.unit <= 0n) return 0;
  const earned = Math.min(Number(amountOut / cfg.unit > 255n ? 255n : amountOut / cfg.unit), cfg.maxPerBuy);
  const left = Math.max(0, cfg.maxSupply - cfg.live - cfg.reservedPending);
  const room = Math.max(0, MAX_PIECES_PER_WALLET - (ticket ? ticket.owned.length + ticket.pending : 0));
  return Math.max(0, Math.min(earned, left, room, 255));
}
/// What a buy that earns `earned` pieces must add to the deposit so that every piece the
/// wallet will have waiting can be minted by anyone: `mintDepositFor` of all of them, less
/// what the deposit already holds. 0n when it holds enough.
export function mintDepositTopUp(rent: RentFn, cfg: { name: string; uriBase: string; minted?: number; locked?: boolean }, ticket: Ticket | null, deposit: bigint, earned: number, opts?: MintDepositOptions): bigint {
  const need = mintDepositFor(rent, cfg, (ticket ? ticket.pending : 0) + earned, opts);
  return need > deposit ? need - deposit : 0n;
}
/// Exactly what `mint_for` minting `n` pieces now costs the deposit: the ticket's growth from
/// `ticketLength` bytes, each asset's rent at its exact number, Core's fee, one KEEPER_FEE.
export function mintForCost(rent: RentFn, cfg: { name: string; uriBase: string; minted: number }, ticketLength: number, owned: number, n: number, opts: MintDepositOptions = {}): bigint {
  if (n <= 0) return 0n;
  const after = Math.max(ticketLength, ticketSpace(owned + n));
  let total = rent(after) - rent(ticketLength) + KEEPER_FEE;
  for (let i = 1; i <= n; i++) total += rent(pieceAssetSize(cfg, cfg.minted + i)) + (opts.coreFee ?? CORE_CREATE_FEE);
  return total;
}
/// What `mint_for` would mint for this wallet now: it reveals what can be revealed, drops
/// the waiting pieces the wallet's coins (`backing`, raw units) no longer back, newest first,
/// then mints every decided piece up to four. `n` 0: nothing to mint (`NothingToMint`).
export function mintForCount(t: Ticket, currentSlot: bigint, backing: bigint, unit: bigint): { n: number; dropped: number } {
  const allowed = unit > 0n ? Number(backing / unit) : 0;
  let excess = Math.max(0, t.owned.length + t.pending - allowed);
  const batches = t.batches.map((b) => ({ ...b }));
  let dropped = 0;
  while (excess > 0) {
    let newest = -1;
    for (let i = 0; i < batches.length; i++) if (batches[i].pieces > 0 && (newest < 0 || batches[i].firstRoll >= batches[newest].firstRoll)) newest = i;
    if (newest < 0) break;
    const take = Math.min(batches[newest].pieces, excess);
    batches[newest].pieces -= take; excess -= take; dropped += take;
  }
  let decided = 0;
  for (const b of batches) {
    if (b.pieces === 0) continue;
    if (b.state === BATCH.REVEALED || b.state === BATCH.EXPIRED || (b.state === BATCH.WAITING && currentSlot > b.targetSlot)) decided += b.pieces;
  }
  return { n: Math.min(decided, MAX_MINT_PER_CALL), dropped };
}

const P = () => PROGRAMS.hook_collectible;
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const sig = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const sigw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
const data = (disc: number[], w?: Writer) => concat(Uint8Array.from(disc), w ? w.toBytes() : new Uint8Array(0));
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

export const collectiblePda = {
  cfg: (pool: PublicKey) => pda.cfg(P(), pool),
  ticket: (pool: PublicKey, user: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("ticket"), pool.toBuffer(), user.toBuffer()], P())[0],
  collection: (pool: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("collection"), pool.toBuffer()], P())[0],
  authority: (pool: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("authority"), pool.toBuffer()], P())[0],
  /// The burn queue of a pegged pool: the pieces its coin's transfers burned.
  queue: (pool: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("queue"), pool.toBuffer()], P())[0],
  /// Where Token-2022 looks for the transfer hook's account list of a pegged coin.
  validation: (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], P())[0],
  /// The n-th piece a wallet minted on a pool (0-based, per wallet).
  asset: (pool: PublicKey, user: PublicKey, index: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("asset"), pool.toBuffer(), user.toBuffer(), u32le(index)], P())[0],
};

export interface CollectionConfig {
  bump: number; authorityBump: number; collectionBump: number; pool: PublicKey; creator: PublicKey; owner: PublicKey;
  collection: PublicKey;
  /// The coin whose balances back the pieces, and its token program. Set when the pool is created.
  baseMint: PublicKey; tokenProgram: PublicKey;
  /// A pegged coin: a Token-2022 mint whose transfer hook is the collectible program. Its
  /// pieces move or burn inside every transfer of the coin, with no settle needed.
  pegged: boolean;
  /// Coins behind one piece: a buy earns one per unit received, a wallet keeps one per unit held.
  unit: bigint;
  /// The most pieces that may exist at once.
  maxSupply: number;
  /// Pieces ever minted (numbers them) and pieces that exist now.
  minted: number; live: number;
  reservedPending: number; maxPerBuy: number;
  artVersion: number; art: Uint8Array; name: string; uriBase: string; locked: boolean;
}
/// `art`: the collection's art bytes when these pieces were earned. They are minted with it.
export interface Batch { state: number; pieces: number; mintedFrom: number; firstRoll: number; targetSlot: bigint; seed: Uint8Array; art: Uint8Array }
export interface Ticket {
  bump: number; pool: PublicKey; user: PublicKey; minted: number; rolls: number;
  /// Pegged coins: pieces staged to travel with the wallet's next transfer, and the slot
  /// the stage holds for.
  staged: number; stagedSlot: bigint;
  batches: Batch[];
  /// The pieces the wallet holds, in its own order. A burn takes the last one.
  owned: PublicKey[];
  /// Pieces earned and not minted yet, decided or not.
  pending: number;
}
/// What a wallet's coins back, and what a settle would remove.
export interface PegStatus {
  /// Pieces the balance backs: floor(balance / unit).
  allowed: number;
  /// Minted and waiting pieces the wallet has.
  held: number;
  /// Waiting pieces a settle drops (they go first).
  dropWaiting: number;
  /// Minted pieces a settle burns, in burn order: the end of the list first.
  burn: PublicKey[];
}
/// The peg for a wallet holding `balance` coins (raw units). Pass the balance AFTER a sell
/// to see what that sell costs.
export function pegStatus(t: Ticket | null, balance: bigint, unit: bigint): PegStatus {
  const allowed = unit > 0n ? Number(balance / unit) : 0;
  if (!t) return { allowed, held: 0, dropWaiting: 0, burn: [] };
  const held = t.owned.length + t.pending;
  const excess = Math.max(0, held - allowed);
  const dropWaiting = Math.min(excess, t.pending);
  const n = Math.min(excess - dropWaiting, t.owned.length);
  return { allowed, held, dropWaiting, burn: t.owned.slice(t.owned.length - n).reverse() };
}
/// Where a ticket stands at a given slot.
export interface TicketStatus {
  /// Pieces whose block has not been produced yet.
  undecided: number;
  /// Pieces that a mint would create right now.
  mintable: number;
  /// The slot after which the next undecided batch can be revealed (0n when none).
  nextRevealAfterSlot: bigint;
}
export function ticketStatus(t: Ticket, currentSlot: bigint): TicketStatus {
  let undecided = 0, mintable = 0, next = 0n;
  for (const b of t.batches) {
    if (b.pieces === 0) continue;
    if (b.state === BATCH.REVEALED || b.state === BATCH.EXPIRED || (b.state === BATCH.WAITING && currentSlot > b.targetSlot)) mintable += b.pieces;
    else if (b.state === BATCH.WAITING) { undecided += b.pieces; if (next === 0n || b.targetSlot < next) next = b.targetSlot; }
  }
  return { undecided, mintable, nextRevealAfterSlot: next };
}
export interface Piece { address: PublicKey; owner: PublicKey; collection: PublicKey | null; name: string; uri: string; number: number | null; art: string | null; seed: string | null }

export function decodeCollectionConfig(bytes: Uint8Array): CollectionConfig {
  if (!discriminatorMatches(bytes, ACCOUNT_DISC.CollectionConfig)) throw new Error("not a CollectionConfig account");
  const r = new Reader(bytes); r.skip(8);
  const bump = r.u8(); const authorityBump = r.u8(); const collectionBump = r.u8();
  const pool = r.pubkey(); const creator = r.pubkey(); const owner = r.pubkey(); const collection = r.pubkey();
  const baseMint = r.pubkey(); const tokenProgram = r.pubkey(); const pegged = r.bool();
  const unit = r.u64(); const maxSupply = r.u32(); const minted = r.u32(); const live = r.u32(); const reservedPending = r.u32(); const maxPerBuy = r.u8();
  const artVersion = r.u16(); const art = Uint8Array.from(r.bytes(16)); const name = r.string(); const uriBase = r.string();
  return { bump, authorityBump, collectionBump, pool, creator, owner, collection, baseMint, tokenProgram, pegged, unit, maxSupply, minted, live, reservedPending, maxPerBuy, artVersion, art, name, uriBase, locked: owner.equals(SYSTEM_PROGRAM) };
}

export function decodeTicket(bytes: Uint8Array): Ticket {
  if (!discriminatorMatches(bytes, ACCOUNT_DISC.Ticket)) throw new Error("not a Ticket account");
  const r = new Reader(bytes); r.skip(8);
  const bump = r.u8(); const pool = r.pubkey(); const user = r.pubkey(); const minted = r.u32(); const rolls = r.u32();
  const staged = r.u8(); const stagedSlot = r.u64();
  const batches: Batch[] = [];
  for (let i = 0; i < 4; i++) {
    const state = r.u8(); const pieces = r.u8(); const mintedFrom = r.u8(); const firstRoll = r.u32(); const targetSlot = r.u64();
    batches.push({ state, pieces, mintedFrom, firstRoll, targetSlot, seed: Uint8Array.from(r.bytes(32)), art: Uint8Array.from(r.bytes(16)) });
  }
  const owned: PublicKey[] = [];
  if (r.off + 4 > bytes.length) throw new Error("not a Ticket account: too short");
  const count = r.u32();
  // bytes in another layout must fail here, not make this loop allocate until the heap dies
  if (count > (bytes.length - r.off) / 32) throw new Error("not a Ticket account: its list is longer than its data");
  for (let i = 0; i < count; i++) owned.push(r.pubkey());
  return { bump, pool, user, minted, rolls, staged, stagedSlot, batches, owned, pending: batches.reduce((n, b) => n + b.pieces, 0) };
}

/// Metaplex Core BaseAssetV1: key, owner, update authority, name, uri.
export function decodePiece(address: PublicKey, bytes: Uint8Array): Piece | null {
  if (bytes.length < 40 || bytes[0] !== 1) return null;
  const r = new Reader(bytes); r.skip(1);
  const owner = r.pubkey();
  const tag = r.u8();
  let collection: PublicKey | null = null;
  if (tag === 1) r.pubkey();
  else if (tag === 2) collection = r.pubkey();
  const name = r.string(); const uri = r.string();
  const m = /#(\d+)$/.exec(name);
  const u = /\/p\/([0-9a-f]{32})\/([0-9a-f]{32})$/.exec(uri);
  return { address, owner, collection, name, uri, number: m ? Number(m[1]) : null, art: u ? u[1] : null, seed: u ? u[2] : null };
}

// ---- instructions ----------------------------------------------------------------------

export interface InitCollectionArgs { name: string; uriBase: string; unit: bigint; maxSupply: number; maxPerBuy: number; art: Uint8Array }
export function initPoolConfig(payer: PublicKey, owner: PublicKey, pool: PublicKey, a: InitCollectionArgs): TransactionInstruction {
  if (a.art.length !== 16) throw new Error("art must be 16 bytes");
  const w = new Writer().pubkey(pool).string(a.name).string(a.uriBase).u64(a.unit).u32(a.maxSupply).u8(a.maxPerBuy).bytes(a.art);
  const keys = [sigw(payer), sig(owner), rw(collectiblePda.cfg(pool)), rw(collectiblePda.collection(pool)), ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.init_pool_config, w) });
}

export function openTicket(user: PublicKey, pool: PublicKey): TransactionInstruction {
  const keys = [sigw(user), rw(collectiblePda.ticket(pool, user)), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.open_ticket, new Writer().pubkey(pool)) });
}

/// Anyone may lock in the outcome of anyone's ticket once its block exists. The watcher
/// does it for every ticket so that nobody can sit on an unrevealed result.
export function reveal(payer: PublicKey, pool: PublicKey, user: PublicKey): TransactionInstruction {
  const keys = [sig(payer), rw(collectiblePda.ticket(pool, user)), ro(SLOT_HASHES)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.reveal) });
}

/// A wallet's token account for the coin: the balance that backs its pieces.
export function coinsAddress(wallet: PublicKey, baseMint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM): PublicKey {
  return pda.ata(wallet, baseMint, tokenProgram);
}

/// Reveal what can be revealed, then mint up to `count` decided pieces. `firstIndex` is the
/// ticket's `minted` counter; `accounts` asset addresses are passed (extra ones are
/// harmless, and the call is a no-op when no piece is decided yet). `coins` is the wallet's
/// token account for the coin: waiting pieces it no longer backs are dropped, not minted.
export function mintPieces(user: PublicKey, pool: PublicKey, count: number, firstIndex: number, accounts: number, coins: PublicKey): TransactionInstruction {
  const keys = [
    sigw(user), rw(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(coins), rw(collectiblePda.collection(pool)),
    ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM), ro(SLOT_HASHES),
  ];
  for (let i = 0; i < accounts; i++) keys.push(rw(collectiblePda.asset(pool, user, firstIndex + i)));
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.mint, new Writer().u8(count)) });
}

/// The deposit: a plain SOL transfer from `user` to its own ticket on `pool`. Put it after
/// the swap of a buy, in the same transaction; the ticket must exist by then (opened
/// earlier in that transaction when new). What the ticket holds above its rent is the
/// wallet's: only its own mints and `withdrawDeposit` take it.
export function depositTransfer(user: PublicKey, pool: PublicKey, lamports: bigint): TransactionInstruction {
  if (lamports <= 0n) throw new Error("a deposit must be at least one lamport");
  return SystemProgram.transfer({ fromPubkey: user, toPubkey: collectiblePda.ticket(pool, user), lamports });
}

/// Anyone mints `user`'s decided pieces INTO `user`, paid by the wallet's deposit: `payer`
/// pays the Metaplex rent and is paid back exactly what it spent plus `KEEPER_FEE`. The
/// program mints every decided piece up to four (`mintForCount`) and needs that many asset
/// addresses: pass `accounts` = min(4, pending) from `firstIndex` = the ticket's `minted`
/// (extra ones are harmless). Refused with `NothingToMint` when nothing is decided and
/// `DepositTooSmall` when the deposit does not cover it; simulate before sending.
export function mintFor(payer: PublicKey, pool: PublicKey, user: PublicKey, firstIndex: number, accounts: number, coins: PublicKey): TransactionInstruction {
  const keys = [
    sigw(payer), ro(user), rw(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(coins), rw(collectiblePda.collection(pool)),
    ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM), ro(SLOT_HASHES),
  ];
  for (let i = 0; i < accounts; i++) keys.push(rw(collectiblePda.asset(pool, user, firstIndex + i)));
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.mint_for) });
}

/// The wallet takes its whole deposit on `pool` back. Refused with `NoDeposit` when there is none.
export function withdrawDeposit(user: PublicKey, pool: PublicKey): TransactionInstruction {
  const keys = [sigw(user), rw(collectiblePda.ticket(pool, user))];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.withdraw_deposit) });
}

/// Anyone may settle any wallet: what its coins no longer back is removed. Waiting pieces
/// are dropped, then minted pieces are burned from the end of the wallet's list. `burn`
/// names the pieces that may go (see `pegStatus`), in any order: the program burns the last
/// piece of the list while it finds it there and the wallet is above the peg, and never
/// anything else. The rent of every burned piece goes to `payer`.
export function settle(payer: PublicKey, pool: PublicKey, user: PublicKey, coins: PublicKey, burn: PublicKey[]): TransactionInstruction {
  const keys = [
    sigw(payer), rw(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(coins), rw(collectiblePda.collection(pool)),
    ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM),
  ];
  for (const a of burn) keys.push(rw(a));
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.settle) });
}

/// The wallet's own order: the piece at `from` goes to position `to`, the others shift.
/// Burns take from the end, so the pieces to keep go first. `coins` is the wallet's token
/// account for the coin (`coinsAddress`): only a wallet whose coins back all its pieces may
/// reorder, so a wallet above the peg cannot shuffle its list to dodge a settle.
export function reorder(user: PublicKey, pool: PublicKey, from: number, to: number, coins: PublicKey): TransactionInstruction {
  if (!coins) throw new Error("reorder needs the wallet's token account for the coin (coinsAddress)");
  const keys = [sig(user), ro(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(coins)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.reorder, new Writer().u32(from).u32(to)) });
}

/// Move up to four pieces to another wallet together with `unit` coins each. The receiving
/// wallet's token account must exist; its ticket is opened by the program if it has none.
export function sendPieces(user: PublicKey, pool: PublicKey, to: PublicKey, baseMint: PublicKey, tokenProgram: PublicKey, pieces: PublicKey[]): TransactionInstruction {
  if (pieces.length < 1 || pieces.length > MAX_SEND) throw new Error("send between 1 and 4 pieces at a time");
  const keys = [
    sigw(user), ro(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(to), rw(collectiblePda.ticket(pool, to)), ro(baseMint),
    rw(coinsAddress(user, baseMint, tokenProgram)), rw(coinsAddress(to, baseMint, tokenProgram)), ro(tokenProgram),
    ro(collectiblePda.collection(pool)), ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM),
  ];
  for (const a of pieces) keys.push(rw(a));
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.send_pieces) });
}

export interface UpdateCollectionArgs { name?: string; uriBase?: string; art?: Uint8Array }
export function updateCollection(owner: PublicKey, pool: PublicKey, a: UpdateCollectionArgs): TransactionInstruction {
  const w = new Writer()
    .option(a.name, (w, v) => w.string(v))
    .option(a.uriBase, (w, v) => w.string(v))
    .option(a.art, (w, v) => w.bytes(v));
  const keys = [sigw(owner), rw(collectiblePda.cfg(pool)), rw(collectiblePda.collection(pool)), ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.update_collection, w) });
}

/// Pass the system program id as `newOwner` to lock the collection forever.
export function setCollectionOwner(owner: PublicKey, pool: PublicKey, newOwner: PublicKey): TransactionInstruction {
  const keys = [sig(owner), rw(collectiblePda.cfg(pool))];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.set_owner, new Writer().pubkey(newOwner)) });
}

/// The hook's callback accounts for a given trader: config, that trader's ticket, SlotHashes.
/// For a pegged coin (`peggedMint`), also what the coin's transfer hook needs for a transfer
/// between the trader and the pool's vault: the vault's (never existing) ticket, the burn
/// queue and the hook's account list.
export function callbackExtras(pool: PublicKey, user: PublicKey, peggedMint?: PublicKey): AccountMeta[] {
  const base = [rw(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(SLOT_HASHES)];
  return peggedMint ? [...base, rw(collectiblePda.ticket(pool, pool)), rw(collectiblePda.queue(pool)), ro(collectiblePda.validation(peggedMint))] : base;
}

// ---- the pegged coin ----------------------------------------------------------------------

/// Everything the coin's transfer hook needs in a transfer from wallet `from` to wallet
/// `to`: config, both tickets, the burn queue, the hook's account list, the hook program.
/// A wallet's Send button resolves the same accounts by itself from the account list.
export function peggedExtras(pool: PublicKey, baseMint: PublicKey, from: PublicKey, to: PublicKey): AccountMeta[] {
  return [
    rw(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, from)), rw(collectiblePda.ticket(pool, to)), rw(collectiblePda.queue(pool)),
    ro(collectiblePda.validation(baseMint)), ro(P()),
  ];
}
/// Bind a pegged coin to its config, in the transaction that creates the coin. The mint signs.
export function initPeg(payer: PublicKey, mint: PublicKey, quoteMint: PublicKey, pool: PublicKey): TransactionInstruction {
  const keys = [sigw(payer), sig(mint), ro(quoteMint), rw(collectiblePda.cfg(pool)), rw(collectiblePda.validation(mint)), rw(collectiblePda.queue(pool)), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.init_peg) });
}
/// Open any wallet's ticket, paid by `payer`. A wallet needs one to receive pieces in a
/// transfer of a pegged coin; without it the pieces burn.
export function openTicketFor(payer: PublicKey, pool: PublicKey, wallet: PublicKey): TransactionInstruction {
  const keys = [sigw(payer), rw(collectiblePda.ticket(pool, wallet)), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.open_ticket_for, new Writer().pubkey(pool).pubkey(wallet)) });
}
/// A plain transfer of a pegged coin between two wallets' token accounts: Token-2022
/// TransferChecked plus the hook's accounts. The pieces the sender's coins no longer back
/// travel with it, or burn (see `predictTransfer`).
export function peggedTransfer(owner: PublicKey, to: PublicKey, pool: PublicKey, baseMint: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const body = new Writer().u8(12).u64(amount).u8(decimals).toBytes();
  const keys = [
    rw(coinsAddress(owner, baseMint, TOKEN_2022_PROGRAM)), ro(baseMint), rw(coinsAddress(to, baseMint, TOKEN_2022_PROGRAM)), sig(owner),
    ...peggedExtras(pool, baseMint, owner, to),
  ];
  return new TransactionInstruction({ programId: TOKEN_2022_PROGRAM, keys, data: Buffer.from(body) });
}
/// Stage pieces to travel with the wallet's next transfer in this slot even though its coins
/// would still back them: one piece per whole unit sent. `pieces` are the last ones of the
/// wallet's list, in list order. If the end of the list is not exactly them when this runs
/// (a piece arrived in the meantime), the transaction fails and nothing is sent.
export function stage(user: PublicKey, pool: PublicKey, pieces: PublicKey[], coins: PublicKey): TransactionInstruction {
  const keys = [sig(user), ro(collectiblePda.cfg(pool)), rw(collectiblePda.ticket(pool, user)), ro(coins), ...pieces.map((p) => ro(p))];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.stage, new Writer().u8(pieces.length)) });
}
/// Hand the Metaplex assets of pieces that moved in a transfer to `holder`, whose list
/// holds them now. Anyone may send it; assets that are not in that list are skipped.
export function deliver(payer: PublicKey, pool: PublicKey, holder: PublicKey, assets: PublicKey[]): TransactionInstruction {
  const keys = [
    sigw(payer), ro(collectiblePda.cfg(pool)), ro(collectiblePda.ticket(pool, holder)), ro(holder), ro(collectiblePda.collection(pool)),
    ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM), ...assets.map(rw),
  ];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.deliver) });
}
/// Burn the Metaplex assets of pieces a pegged coin's transfers burned. Anyone may send
/// it and receives their rent; assets that are not in the burn queue are skipped.
export function reap(payer: PublicKey, pool: PublicKey, assets: PublicKey[]): TransactionInstruction {
  const keys = [
    sigw(payer), ro(collectiblePda.cfg(pool)), rw(collectiblePda.queue(pool)), rw(collectiblePda.collection(pool)),
    ro(collectiblePda.authority(pool)), ro(MPL_CORE), ro(SYSTEM_PROGRAM), ...assets.map(rw),
  ];
  return new TransactionInstruction({ programId: P(), keys, data: data(IX.hook_collectible.reap) });
}
/// What a transfer of a pegged coin does to the sender's pieces, worked out the way the
/// hook does. `receiverBalance` is what the receiver holds BEFORE the transfer. `staged`:
/// pieces staged for this transfer (0 for a plain one).
///
/// The rule: pieces the sender's coins no longer back leave from the end of its list. The
/// receiver takes one piece per whole unit this transfer sends, within what its own coins
/// back and the cap of 200; the rest burns. A staged piece travels with a whole unit
/// of its own and never burns. Waiting pieces are dropped before a minted piece leaves.
export interface TransferOutcome {
  /// Waiting pieces dropped at the sender.
  dropWaiting: number;
  /// Pieces that move to the receiver's list, in the order they arrive there.
  moved: PublicKey[];
  /// Pieces that burn.
  burned: PublicKey[];
}
export function predictTransfer(
  sender: Ticket | null, senderBalance: bigint, receiver: Ticket | null, receiverBalance: bigint, amount: bigint, unit: bigint,
  opts: { staged?: number; toPool?: boolean } = {},
): TransferOutcome {
  const none: TransferOutcome = { dropWaiting: 0, moved: [], burned: [] };
  if (!sender || unit <= 0n) return none;
  const owned = sender.owned.length; const pending = sender.pending;
  if (owned + pending === 0) return none;
  const toPool = !!opts.toPool;
  const after = senderBalance > amount ? senderBalance - amount : 0n;
  const least = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));
  // a staged piece travels with its coins: one per whole unit sent, never into the pool
  const staged = toPool ? 0 : Number(least(BigInt(Math.min(opts.staged ?? 0, owned)), amount / unit));
  const total = BigInt(owned + pending); const allowed = after / unit;
  const excessTotal = total > allowed ? Number(total - allowed) : 0;
  if (excessTotal === 0 && staged === 0) return none;
  // the receiver takes one piece per whole unit this transfer sends
  let room = 0;
  if (receiver && !toPool && !(receiver.user && sender.user && receiver.user.equals(sender.user))) {
    const theirs = BigInt(receiver.owned.length + receiver.pending);
    const backed = (receiverBalance + amount) / unit;
    const cap = BigInt(MAX_PIECES_PER_WALLET);
    room = Number(least(amount / unit, backed > theirs ? backed - theirs : 0n, cap > theirs ? cap - theirs : 0n));
  }
  // staged pieces that travel take their coins with them; only what is unbacked after that goes
  const stagedOut = Math.min(staged, room);
  const dropWaiting = Math.min(pending, Math.max(0, excessTotal - stagedOut));
  const excess = Math.min(owned, excessTotal - dropWaiting);
  const moved = Math.min(Math.max(excess, stagedOut), room);
  const leaving = sender.owned.slice(owned - Math.max(moved, excess)).reverse();
  return { dropWaiting, moved: leaving.slice(0, moved), burned: leaving.slice(moved) };
}
/// The pieces waiting in a pegged pool's burn queue for their Metaplex asset to be burned.
export async function fetchQueue(connection: Connection, pool: PublicKey): Promise<PublicKey[]> {
  const info = await connection.getAccountInfo(collectiblePda.queue(pool));
  if (!info || info.data.length < 44) return [];
  const d = new Uint8Array(info.data);
  const n = new DataView(d.buffer, d.byteOffset + 40, 4).getUint32(0, true);
  return Array.from({ length: Math.min(n, Math.floor((d.length - 44) / 32)) }, (_, i) => new PublicKey(d.subarray(44 + 32 * i, 76 + 32 * i)));
}
/// Pieces whose Metaplex asset is not yet with the wallet whose list holds them (they moved
/// in a transfer and nobody delivered them yet), grouped by holder. For the delivery crank.
export async function fetchUndelivered(connection: Connection, pool: PublicKey): Promise<{ holder: PublicKey; assets: PublicKey[] }[]> {
  const tickets = (await fetchTickets(connection, pool)).filter((t) => t.owned.length > 0);
  const keys = tickets.flatMap((t) => t.owned);
  const owners: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100));
    for (const info of infos) owners.push(info && info.data.length >= 33 && info.data[0] === 1 ? new PublicKey(info.data.subarray(1, 33)).toBase58() : null);
  }
  const out: { holder: PublicKey; assets: PublicKey[] }[] = [];
  let at = 0;
  for (const t of tickets) {
    const stale = t.owned.filter((_, j) => { const o = owners[at + j]; return o !== null && o !== t.user.toBase58(); });
    at += t.owned.length;
    if (stale.length) out.push({ holder: t.user, assets: stale });
  }
  return out;
}

// ---- reads ---------------------------------------------------------------------------------

export async function fetchCollectionConfig(connection: Connection, pool: PublicKey): Promise<CollectionConfig | null> {
  const info = await connection.getAccountInfo(collectiblePda.cfg(pool));
  return info ? decodeCollectionConfig(new Uint8Array(info.data)) : null;
}
/// Every ticket of the hook, optionally of one pool. For keepers.
export async function fetchTickets(connection: Connection, pool?: PublicKey): Promise<Ticket[]> {
  const filters: any[] = [{ memcmp: { offset: 0, bytes: b58(ACCOUNT_DISC.Ticket) } }];
  if (pool) filters.push({ memcmp: { offset: 9, bytes: pool.toBase58() } });
  const accs = await connection.getProgramAccounts(P(), { filters });
  const out: Ticket[] = [];
  // an account in a layout this SDK does not know is skipped, so one of them cannot stop a keeper
  for (const a of accs) { try { out.push(decodeTicket(new Uint8Array(a.account.data))); } catch { /* skipped */ } }
  return out;
}
/// Tickets with pieces still waiting to be minted. For the reveal crank.
export async function fetchOpenTickets(connection: Connection, pool?: PublicKey): Promise<Ticket[]> {
  return (await fetchTickets(connection, pool)).filter((t) => t.pending > 0);
}
/// Tickets with pieces waiting AND a deposit, each with its deposit and size. For the mint
/// crank: `mintForCount` says what a `mintFor` would mint now, `mintForCost` what it costs.
/// The deposit is read at the ticket's current length (`depositOf`), the way `mint_for` checks
/// it. The chain's rent is read when it is not given (a keeper keeps it: `rentReader`).
export async function fetchDepositTickets(connection: Connection, pool?: PublicKey, rent?: RentFn): Promise<{ address: PublicKey; ticket: Ticket; deposit: bigint; dataLength: number }[]> {
  const filters: any[] = [{ memcmp: { offset: 0, bytes: b58(ACCOUNT_DISC.Ticket) } }];
  if (pool) filters.push({ memcmp: { offset: 9, bytes: pool.toBase58() } });
  const [accs, r] = await Promise.all([connection.getProgramAccounts(P(), { filters }), rent ? Promise.resolve(rent) : rentFrom(connection)]);
  const out: { address: PublicKey; ticket: Ticket; deposit: bigint; dataLength: number }[] = [];
  for (const a of accs) {
    try {
      const ticket = decodeTicket(new Uint8Array(a.account.data));
      const deposit = depositOf(a.account.lamports, a.account.data.length, r);
      if (ticket.pending > 0 && deposit > 0n) out.push({ address: a.pubkey, ticket, deposit, dataLength: a.account.data.length });
    } catch { /* another layout: skipped */ }
  }
  return out;
}
/// Raw coin balances of token accounts, 0n for the ones that do not exist. This is NOT
/// what backs pieces: use `fetchBacking`, which reads the account the way the program does.
export async function fetchCoinBalances(connection: Connection, accounts: PublicKey[]): Promise<bigint[]> {
  const out: bigint[] = [];
  for (let i = 0; i < accounts.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(accounts.slice(i, i + 100));
    for (const info of infos) out.push(info && info.data.length >= 72 ? new Reader(new Uint8Array(info.data).subarray(64, 72)).u64() : 0n);
  }
  return out;
}
/// The coins that back a wallet's pieces, exactly as the program counts them: the balance
/// of the wallet's associated token account, and only while that account belongs to the
/// coin's token program, holds this coin and is still owned by the wallet. A token account
/// handed to another owner, or one that does not exist, backs nothing.
export function backingOf(info: { owner: PublicKey; data: Uint8Array } | null | undefined, wallet: PublicKey, baseMint: PublicKey, tokenProgram: PublicKey): bigint {
  if (!info || info.data.length < 72 || !info.owner.equals(tokenProgram)) return 0n;
  const d = new Uint8Array(info.data);
  if (!new PublicKey(d.subarray(0, 32)).equals(baseMint) || !new PublicKey(d.subarray(32, 64)).equals(wallet)) return 0n;
  return new Reader(d.subarray(64, 72)).u64();
}
/// `backingOf` for many wallets of one collection, one read per hundred.
export async function fetchBacking(connection: Connection, cfg: { baseMint: PublicKey; tokenProgram: PublicKey }, wallets: PublicKey[]): Promise<bigint[]> {
  const accounts = wallets.map((w) => coinsAddress(w, cfg.baseMint, cfg.tokenProgram));
  const out: bigint[] = [];
  for (let i = 0; i < accounts.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(accounts.slice(i, i + 100));
    infos.forEach((info, j) => out.push(backingOf(info, wallets[i + j], cfg.baseMint, cfg.tokenProgram)));
  }
  return out;
}
/// Wallets holding more pieces than their coins back, with what a settle would remove. For
/// the settle crank: one read for the tickets, one per hundred wallets for the balances.
export async function fetchUnbacked(connection: Connection, cfg: CollectionConfig): Promise<{ ticket: Ticket; coins: PublicKey; balance: bigint; peg: PegStatus }[]> {
  const tickets = (await fetchTickets(connection, cfg.pool)).filter((t) => t.owned.length + t.pending > 0);
  const accounts = tickets.map((t) => coinsAddress(t.user, cfg.baseMint, cfg.tokenProgram));
  const balances = await fetchBacking(connection, cfg, tickets.map((t) => t.user));
  return tickets.map((ticket, i) => ({ ticket, coins: accounts[i], balance: balances[i], peg: pegStatus(ticket, balances[i], cfg.unit) }))
    .filter((x) => x.peg.dropWaiting > 0 || x.peg.burn.length > 0);
}
function b58(bytes: number[]): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

export async function fetchTicket(connection: Connection, pool: PublicKey, user: PublicKey): Promise<Ticket | null> {
  const info = await connection.getAccountInfo(collectiblePda.ticket(pool, user));
  return info && info.data.length > 0 ? decodeTicket(new Uint8Array(info.data)) : null;
}

async function fetchPieces(connection: Connection, keys: PublicKey[]): Promise<Piece[]> {
  const out: Piece[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100));
    infos.forEach((info, j) => { if (info) { const p = decodePiece(keys[i + j], new Uint8Array(info.data)); if (p) out.push(p); } });
  }
  return out;
}
/// The pieces a wallet holds on a pool, in the wallet's own order: a sell burns the LAST
/// one first. This is the list to show a holder.
export async function fetchOwnedPieces(connection: Connection, pool: PublicKey, user: PublicKey): Promise<Piece[]> {
  const t = await fetchTicket(connection, pool, user);
  return t && t.owned.length ? fetchPieces(connection, t.owned) : [];
}
/// Pieces a wallet minted on a pool that still exist, in mint order, whoever holds them
/// now. Burned ones are gone.
export async function fetchPiecesMintedBy(connection: Connection, pool: PublicKey, user: PublicKey): Promise<Piece[]> {
  const t = await fetchTicket(connection, pool, user);
  if (!t || t.minted === 0) return [];
  return fetchPieces(connection, Array.from({ length: t.minted }, (_, i) => collectiblePda.asset(pool, user, i)));
}

/// Every piece of a pool's collection, whoever holds it now.
export async function fetchCollectionPieces(connection: Connection, pool: PublicKey): Promise<Piece[]> {
  const collection = collectiblePda.collection(pool);
  const accs = await connection.getProgramAccounts(MPL_CORE, {
    filters: [{ memcmp: { offset: 0, bytes: "2" } }, { memcmp: { offset: 34, bytes: collection.toBase58() } }],
  });
  return accs.map((a) => decodePiece(a.pubkey, new Uint8Array(a.account.data))).filter((p): p is Piece => p !== null)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// ---- art -------------------------------------------------------------------------------------

export function hexOf(bytes: Uint8Array): string { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
export function bytesOfHex(hex: string): Uint8Array { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }

export interface PieceTraits { body: number; eyes: number; horn: number; mark: number; mirror: boolean; hueMain: number; hueAccent: number; hueBg: number; rarity: "common" | "uncommon" | "rare" }

/// Traits of a piece, from its seed and the art parameters it was minted under.
/// art[0] theme, art[1] background hue, art[2] main hue, art[3] accent hue, art[4] hue spread,
/// art[5] rare chance (per 255). The rest is reserved.
export function pieceTraits(artHex: string, seedHex: string): PieceTraits {
  const art = bytesOfHex(artHex); const s = bytesOfHex(seedHex);
  const spread = art[4] || 24;
  const wob = (b: number) => ((b / 255) * 2 - 1) * spread;
  const roll = s[9];
  const rareAt = art[5] || 12;
  return {
    body: s[0] % 6, eyes: s[1] % 5, horn: s[2] % 4, mark: s[3] % 6, mirror: (s[4] & 1) === 0,
    hueMain: Math.round((art[2] * 360) / 255 + wob(s[5]) + 360) % 360,
    hueAccent: Math.round((art[3] * 360) / 255 + wob(s[6]) + 360) % 360,
    hueBg: Math.round((art[1] * 360) / 255 + wob(s[7]) / 2 + 360) % 360,
    rarity: roll < rareAt ? "rare" : roll < Math.min(rareAt * 4, 255) ? "uncommon" : "common",
  };
}

/// A 24x24 pixel creature as an SVG string. Deterministic: same art and seed, same image.
export function renderPieceSvg(artHex: string, seedHex: string, size = 480): string {
  const t = pieceTraits(artHex, seedHex);
  const s = bytesOfHex(seedHex);
  const N = 24;
  const grid: number[][] = Array.from({ length: N }, () => Array(N).fill(0));
  let st = 0;
  for (const b of s) st = (st * 31 + b + 7) >>> 0;
  const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
  // body: a blob grown on the left half, mirrored
  const cx = 11, cy = 13, rx = 5 + (t.body % 3), ry = 6 + (t.body >> 1);
  for (let y = 0; y < N; y++) for (let x = 0; x < 12; x++) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    const d = dx * dx + dy * dy;
    if (d < 1 - rnd() * 0.25) grid[y][x] = 1;
  }
  // markings
  for (let y = 6; y < 20; y++) for (let x = 5; x < 12; x++) if (grid[y][x] === 1 && rnd() < 0.08 + t.mark * 0.03) grid[y][x] = 2;
  // horn or ears
  const hornH = 2 + t.horn;
  for (let i = 0; i < hornH; i++) { const y = cy - ry - i; if (y >= 0) { grid[y][cx - (t.horn % 2 ? i >> 1 : 0)] = 2; } }
  // eyes
  const ey = cy - 2 + (t.eyes % 2), ex = cx - 2 - (t.eyes >> 2);
  grid[ey][ex] = 3; if (t.eyes > 2) grid[ey + 1][ex] = 3;
  // mirror
  for (let y = 0; y < N; y++) for (let x = 0; x < 12; x++) grid[y][N - 1 - x] = grid[y][x];
  if (!t.mirror) for (let y = cy; y < cy + 3; y++) grid[y][N - 1 - (cx - 3)] = 2;
  const light = t.rarity === "rare" ? 62 : 54;
  const col = ["", `hsl(${t.hueMain} 78% ${light}%)`, `hsl(${t.hueAccent} 85% 62%)`, "#0a0a0d"];
  const bg = t.rarity === "rare" ? `hsl(${t.hueBg} 55% 20%)` : `hsl(${t.hueBg} 30% 13%)`;
  let rects = "";
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (grid[y][x]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${col[grid[y][x]]}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${N}" height="${N}" fill="${bg}"/>${rects}</svg>`;
}

/// Metaplex-style JSON for a piece, as the renderer endpoint serves it.
export function pieceMetadata(artHex: string, seedHex: string, name: string, imageUrl: string) {
  const t = pieceTraits(artHex, seedHex);
  return {
    name, image: imageUrl,
    description: "Minted by a trade on Programmable. The seed and the art parameters are fixed in this piece's address on chain.",
    attributes: [
      { trait_type: "Rarity", value: t.rarity }, { trait_type: "Body", value: t.body }, { trait_type: "Eyes", value: t.eyes },
      { trait_type: "Horn", value: t.horn }, { trait_type: "Mark", value: t.mark }, { trait_type: "Mirror", value: t.mirror ? "yes" : "no" },
      { trait_type: "Seed", value: seedHex }, { trait_type: "Art", value: artHex },
    ],
  };
}
