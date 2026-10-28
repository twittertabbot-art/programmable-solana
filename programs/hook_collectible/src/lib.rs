//! hook_collectible: platform template hook.
//!
//! Every buy earns the buyer collectibles: one Metaplex Core NFT per `unit` coins bought,
//! at most `max_per_buy` per trade and `max_supply` in total.
//!
//! WHAT A PIECE LOOKS LIKE CANNOT BE KNOWN WHEN THE BUY IS MADE. A buy only records
//! "N pieces, decided by the first block at or after slot S + 2". The seed is the hash of
//! that future block (SlotHashes sysvar), mixed with the pool, the wallet and a per-ticket
//! roll counter fixed at buy time. So:
//!   * simulating the buy shows nothing: no seed exists yet;
//!   * nothing the buyer does later can change the seed: it does not depend on when they
//!     reveal, on when they mint, or on any counter that moves after the buy;
//!   * anyone may reveal anyone's ticket (`reveal` is permissionless; the watcher does it),
//!     so a buyer cannot peek at a bad result and leave it unrevealed;
//!   * a batch not revealed while its block hash is still available (512 slots, about
//!     3.5 minutes) expires: its pieces are forced to the common tier, which is never
//!     better than what a reveal could have given;
//!   * a later buy first locks in every batch whose block has passed, then adds new
//!     pieces only to a batch whose outcome is still unknown, or to a fresh one.
//! What remains: the leader of the target slot could bias a block hash. That takes a
//! validator, per block, and is out of scope for collectible art.
//!
//! The hook never receives the buyer's signature. The buyer's own instructions are
//! `open_ticket` (once), the pool `swap`, and `mint` at least two slots later. A buy
//! without a ticket earns nothing and never fails because of this hook. Sells are never
//! seen by the hook (no CALL_ON_SELL), so this hook can never block one.
//!
//! ONE APPROVAL. The buyer may pay the NFTs' rent inside the buy as a DEPOSIT: a plain SOL
//! transfer from the buyer to its own ticket. The deposit is whatever a ticket holds above
//! its rent-exempt minimum. Anyone may then send `mint_for`, which mints the wallet's
//! decided pieces into the wallet and pays its sender back, out of that deposit, exactly
//! what it spent plus `KEEPER_FEE`. `mint` by the wallet takes from the deposit first too,
//! and `withdraw_deposit` gives the wallet the rest. Every other instruction leaves a
//! ticket's lamports where they are. When pieces leave a list (`settle`, `send_pieces`, a
//! pegged coin's transfer) the ticket shrinks to fit, and the rent of the bytes it frees
//! stays in it as the wallet's deposit (a pegged transfer first pays with it the place the
//! pieces take at the receiver or in the burn queue).
//!
//! PIECES ARE PEGGED TO THE COIN. A wallet holds at most one piece per `unit` coins in
//! its token account, the rule of Unipeg (uPEG) on Ethereum:
//!   * a buy mints one piece per `unit` coins bought;
//!   * when the coins leave (a sell, a transfer, anything), `settle` removes what is no
//!     longer backed, newest first: waiting pieces are dropped, then minted pieces are
//!     burned from the END of the wallet's list. `settle` is permissionless: the site
//!     sends it in the same transaction as a sell and the watcher sends it for everybody
//!     else. Whoever sends it receives the rent of the pieces it burns;
//!   * the wallet orders its own list with `reorder` while its coins back it, so it
//!     chooses what a sell burns;
//!   * a piece moves to another wallet only with `send_pieces`, which moves `unit` coins
//!     with it, and only from a wallet whose coins back all its pieces. Pieces are frozen in Metaplex Core: no marketplace, no plain transfer.
//!
//! TWO KINDS OF COIN. A plain coin (SPL Token) has no code of its own: the peg is kept by
//! `settle`, sent with every sell by the site and by the watcher for everything else. A
//! PEGGED coin is a Token-2022 mint whose transfer hook is this program, bound with
//! `init_peg`. Then every transfer of the coin runs `execute`, which applies uPEG's
//! `_afterTokenTransfer` in the transfer itself:
//!   * what the sender's coins no longer back leaves the sender, from the END of its list;
//!   * it moves to the receiver, as far as the receiver has a ticket, room and the coins
//!     arrived in its associated token account; the rest is burned;
//!   * a transfer out of the pool is a buy: nothing moves, the pool's callback records
//!     what the buy earns.
//! The wallet lists are the truth and change inside the transfer. The Metaplex Core
//! assets follow: `deliver` hands a moved piece to its new holder, `reap` burns the
//! pieces the hook put in the pool's burn queue. Both are permissionless; the site sends
//! them in the same transaction and the watcher sweeps the rest. `execute` makes no CPI
//! and never fails a real transfer.
//!
//! The collection is created with three permanent Core plugins held by this program's
//! authority PDA: freeze (holders cannot move or burn a piece themselves), transfer and
//! burn (only this program can).
//!
//! The launcher may update the collection name, the renderer base URI and the art
//! parameters until they lock it. Updates only affect pieces minted afterwards. Supply and
//! unit are fixed at creation.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use hookpool_interface::*;
use solana_sha256_hasher::hashv;

declare_id!("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m");

/// Metaplex Core.
pub const MPL_CORE_ID: Pubkey = Pubkey::from_str_const("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/// The SlotHashes sysvar: the last 512 (slot, block hash) pairs.
pub const SLOT_HASHES_ID: Pubkey = Pubkey::from_str_const("SysvarS1otHashes111111111111111111111111111");

pub const CFG_SEED: &[u8] = b"cfg";
pub const TICKET_SEED: &[u8] = b"ticket";
pub const COLLECTION_SEED: &[u8] = b"collection";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const ASSET_SEED: &[u8] = b"asset";

/// Runs after buys only. Takes no fee, changes no price, never sees a sell.
pub const FLAGS: u32 = AFTER_SWAP | ON_POOL_CREATE | CALL_ON_BUY;

pub const MAX_PER_BUY_CAP: u8 = 5;
pub const MAX_MINT_PER_CALL: u8 = 4;
/// What `mint_for` pays its sender out of the wallet's deposit, per call that mints, on top
/// of what the sender spent: one signature (5,000 lamports) and a little for its priority
/// fee. A call mints every decided piece it can, up to `MAX_MINT_PER_CALL`, so the pieces
/// of one buy cost at most one fee per four.
pub const KEEPER_FEE: u64 = 10_000;
/// Metaplex Core's own bytes in an asset with no plugins: key, owner, update authority
/// (tag and collection), the two string lengths, `seq` (None). The name and the URI follow.
pub const CORE_ASSET_FIXED_LEN: usize = 1 + 32 + 33 + 4 + 4 + 1;
/// Pieces one `send_pieces` may move.
pub const MAX_SEND: usize = 4;
/// The most pieces, minted and waiting, one wallet may hold on one pool. The list is read
/// into the program's 32 KB heap on every call; this keeps every instruction far from it.
pub const MAX_PIECES_PER_WALLET: usize = 200;

pub const TOKEN_PROGRAM_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// The burn queue of a pegged pool.
pub const QUEUE_SEED: &[u8] = b"queue";
/// Where Token-2022 looks for a transfer hook's account list: `[this, mint]`.
pub const VALIDATION_SEED: &[u8] = TRANSFER_HOOK_METAS_SEED;
/// The transfer hook interface's `Execute` discriminator and the TLV key of its account list.
pub const EXECUTE_DISC: [u8; 8] = TRANSFER_HOOK_EXECUTE_DISC;
pub use hookpool_interface::TransferHookExecute as ExecuteInstruction;
/// Token-2022 extension types (u16) this program reads by hand.
const EXT_TRANSFER_HOOK: u16 = 14;
const EXT_TRANSFER_HOOK_ACCOUNT: u16 = 15;
/// Token-2022 puts the account type at byte 165 (1 mint, 2 token account), then TLV entries.
const T22_ACCOUNT_TYPE: usize = 165;
/// Token-2022 gives a multisig exactly this many bytes, and whoever creates a multisig
/// chooses its contents. Like the token program itself, never read an account of this
/// length as a mint or a token account.
const T22_MULTISIG_LEN: usize = 355;
/// The most burned pieces that may wait in a pool's burn queue. A transfer that would go
/// past it leaves its unbacked pieces on the sender's list for `settle`. Keeps the queue
/// account small, so its size never costs a transfer much compute and never reaches the
/// account size limit.
pub const MAX_QUEUE: usize = 4096;

// Byte layout of a Ticket account, for the transfer hook, which works on the raw bytes so
// that a transfer never depends on the heap. The tests check it against borsh.
pub const T_POOL: usize = 9;
pub const T_USER: usize = 41;
pub const T_STAGED: usize = 81;
pub const T_STAGED_SLOT: usize = 82;
pub const T_BATCHES: usize = 90;
pub const T_BATCH: usize = 63;
pub const T_COUNT: usize = T_BATCHES + MAX_BATCHES * T_BATCH;
pub const T_OWNED: usize = T_COUNT + 4;
// Byte layout of a BurnQueue account: discriminator, pool, count, then the asset addresses.
pub const Q_POOL: usize = 8;
pub const Q_COUNT: usize = 40;
pub const Q_ENTRIES: usize = 44;
pub const MAX_NAME: usize = 24;
pub const MAX_URI_BASE: usize = 80;
/// A buy at slot S is decided by the first block at or after S + this.
pub const REVEAL_DELAY_SLOTS: u64 = 2;
pub const MAX_BATCHES: usize = 4;

pub const BATCH_EMPTY: u8 = 0;
/// Earned, block not seen yet (or seen but nobody revealed yet).
pub const BATCH_WAITING: u8 = 1;
pub const BATCH_REVEALED: u8 = 2;
/// Nobody revealed in time. Pieces are forced to the common tier.
pub const BATCH_EXPIRED: u8 = 3;

#[account]
#[derive(InitSpace)]
pub struct HookManifest {
    pub version: u8,
    pub flags: u32,
    pub admin: Option<Pubkey>,
    pub name: [u8; 32],
    pub uri: [u8; 128],
}

#[account]
#[derive(InitSpace)]
pub struct CollectionConfig {
    pub bump: u8,
    pub authority_bump: u8,
    pub collection_bump: u8,
    pub pool: Pubkey,
    /// Who paid for this config. Must be the pool creator.
    pub creator: Pubkey,
    /// May update name, renderer and art. Pubkey::default() = locked forever.
    pub owner: Pubkey,
    /// The Metaplex Core collection, a PDA of this program.
    pub collection: Pubkey,
    /// The coin and its token program, recorded by the pool when it is created (a plain
    /// coin) or by `init_peg` (a pegged coin).
    pub base_mint: Pubkey,
    pub token_program: Pubkey,
    /// The coin is a Token-2022 mint whose transfer hook is this program: its pieces move
    /// or burn inside every transfer.
    pub pegged: bool,
    /// Coins (raw units) behind one piece: a buy earns one per `unit` received, and a
    /// wallet keeps one per `unit` held. Fixed.
    pub unit: u64,
    /// The most pieces that may exist at once. Fixed.
    pub max_supply: u32,
    /// Pieces ever minted. Only numbers them.
    pub minted: u32,
    /// Pieces that exist now.
    pub live: u32,
    /// Pieces earned and waiting in tickets.
    pub reserved_pending: u32,
    /// Fixed.
    pub max_per_buy: u8,
    /// Bumped on every art or renderer change.
    pub art_version: u16,
    /// Opaque art parameters, copied into every piece's URI at mint time.
    pub art: [u8; 16],
    #[max_len(MAX_NAME)]
    pub name: String,
    #[max_len(MAX_URI_BASE)]
    pub uri_base: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Batch {
    pub state: u8,
    /// Pieces of this batch not minted yet.
    pub pieces: u8,
    /// Pieces of this batch already minted.
    pub minted_from: u8,
    /// Roll number of this batch's first piece, fixed when it was earned.
    pub first_roll: u32,
    /// The seed is the hash of the first block at or after this slot.
    pub target_slot: u64,
    /// Zero until revealed.
    pub seed: [u8; 32],
    /// The collection's art bytes when these pieces were earned. A piece is minted with
    /// them, whatever the owner changes between the buy and the mint.
    pub art: [u8; 16],
}

#[account]
#[derive(Debug)]
pub struct Ticket {
    pub bump: u8,
    pub pool: Pubkey,
    pub user: Pubkey,
    /// Pieces this wallet has ever minted on this pool: the index of its next asset address.
    pub minted: u32,
    /// Pieces this wallet has ever earned on this pool. Each piece's roll number comes
    /// from here at buy time and never moves.
    pub rolls: u32,
    /// Pegged coins: how many pieces, from the end of the list, travel with the wallet's
    /// next transfer even though its coins would still back them. Only honoured in the
    /// slot it was set in, so a stale stage can never move a piece by surprise.
    pub staged: u8,
    pub staged_slot: u64,
    pub batches: [Batch; MAX_BATCHES],
    /// The pieces this wallet holds, in the wallet's own order. A burn takes the last one.
    pub owned: Vec<Pubkey>,
}

impl Ticket {
    /// Account size for a wallet holding `n` pieces.
    pub fn space(n: usize) -> usize {
        8 + 1 + 32 + 32 + 4 + 4 + 1 + 8 + MAX_BATCHES * Batch::INIT_SPACE + 4 + 32 * n
    }
    pub fn pending(&self) -> u32 {
        self.batches.iter().map(|b| b.pieces as u32).sum()
    }
    /// Minted and waiting pieces together: what the coins have to back.
    pub fn pieces(&self) -> u64 {
        self.owned.len() as u64 + self.pending() as u64
    }
}

/// The pieces a pegged coin's transfers burned, waiting for their Metaplex Core asset to
/// be burned too (`reap`). The asset addresses follow this header as raw 32-byte entries;
/// the transfer hook appends without ever reading the list.
#[account]
pub struct BurnQueue {
    pub pool: Pubkey,
    pub count: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitCollectionArgs {
    pub name: String,
    pub uri_base: String,
    pub unit: u64,
    pub max_supply: u32,
    pub max_per_buy: u8,
    pub art: [u8; 16],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateCollectionArgs {
    pub name: Option<String>,
    pub uri_base: Option<String>,
    pub art: Option<[u8; 16]>,
}

#[event]
pub struct PiecesEarned {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub pieces: u32,
    pub slot: u64,
    pub target_slot: u64,
}

#[event]
pub struct BatchRevealed {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub target_slot: u64,
    pub expired: bool,
}

#[event]
pub struct PieceMinted {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub asset: Pubkey,
    pub number: u32,
    pub seed: [u8; 16],
    pub art_version: u16,
}

/// Waiting pieces dropped because the wallet no longer holds the coins for them.
#[event]
pub struct PiecesCancelled {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub pieces: u32,
}

#[event]
pub struct PieceBurned {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub asset: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct PieceSent {
    pub pool: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub asset: Pubkey,
}

/// The Metaplex asset of a piece that moved in a transfer was handed to its holder.
#[event]
pub struct PieceDelivered {
    pub pool: Pubkey,
    pub asset: Pubkey,
    pub to: Pubkey,
    pub by: Pubkey,
}

/// What one transfer of a pegged coin did to the sender's pieces.
#[event]
pub struct PiecesTransferred {
    pub pool: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    /// Waiting pieces dropped.
    pub dropped: u32,
    /// Pieces that moved to the receiver's list.
    pub moved: u32,
    /// Pieces burned (queued for `reap`).
    pub burned: u32,
}

#[event]
pub struct CollectionUpdated {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub art_version: u16,
    pub locked: bool,
}

/// A mint took lamports out of the wallet's deposit: `mint` by the wallet itself, or
/// `mint_for` by anyone. `paid` went to `by`.
#[event]
pub struct DepositUsed {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub by: Pubkey,
    /// Pieces this call minted.
    pub pieces: u32,
    /// Lamports paid to `by`: what it spent on the assets, plus `KEEPER_FEE` for `mint_for`.
    pub paid: u64,
    /// The deposit left after this call.
    pub left: u64,
}

/// The wallet took its whole deposit back.
#[event]
pub struct DepositWithdrawn {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub lamports: u64,
}

#[error_code]
pub enum CollectibleError {
    #[msg("name is empty or longer than 24 bytes")]
    BadName,
    #[msg("renderer base uri is empty or longer than 80 bytes")]
    BadUriBase,
    #[msg("unit must be greater than zero")]
    BadUnit,
    #[msg("max supply must be greater than zero")]
    BadSupply,
    #[msg("max per buy must be between 1 and 5")]
    BadMaxPerBuy,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
    #[msg("only the collection owner can do this")]
    NotOwner,
    #[msg("collection is locked")]
    Locked,
    #[msg("ticket does not belong to this wallet and pool")]
    WrongTicket,
    #[msg("asset account is not the expected address")]
    WrongAsset,
    #[msg("slot hashes sysvar could not be read")]
    SlotHashes,
    #[msg("that is not the wallet's token account for this coin")]
    WrongCoins,
    #[msg("the wallet does not hold this piece")]
    NotHeld,
    #[msg("no such position in the wallet's list")]
    BadIndex,
    #[msg("send between 1 and 4 pieces at a time")]
    BadCount,
    #[msg("a wallet cannot send pieces to itself")]
    SameWallet,
    #[msg("the receiving wallet's list is full")]
    ListFull,
    #[msg("this wallet holds more pieces than its coins back: settle it first")]
    AboveThePeg,
    #[msg("only the token program calls this, in the middle of a transfer of this coin")]
    NotATransfer,
    #[msg("the coin must be a Token-2022 mint whose transfer hook is this program, with no hook authority")]
    BadPegMint,
    #[msg("this config is already bound to a coin")]
    AlreadyPegged,
    #[msg("a pegged coin trades in one pool only, the one it was bound to")]
    NotPegged,
    #[msg("this coin carries its pieces in a plain transfer: move the piece to the end of the list and send the coins")]
    UseTransfer,
    #[msg("the burn queue does not belong to this pool")]
    WrongQueue,
    #[msg("staging is for pegged coins; a plain coin sends its pieces with send_pieces")]
    NotPeggedCoin,
    #[msg("the end of the wallet's list is not the pieces named: the list changed, nothing was staged")]
    NotStaged,
    #[msg("this pool does not run this hook")]
    WrongHook,
    #[msg("the wallet's deposit does not cover this mint: the rent of the pieces, the ticket's growth and the keeper fee")]
    DepositTooSmall,
    #[msg("no decided piece to mint for this wallet")]
    NothingToMint,
    #[msg("a mint for another wallet mints every decided piece, up to 4: pass that many asset addresses")]
    TooFewAssets,
    #[msg("this ticket holds no deposit")]
    NoDeposit,
}

// ---- the randomness ------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum SlotLookup {
    /// Hash of the first block at or after the target slot.
    Found([u8; 32]),
    /// No block at or after the target is recorded yet.
    NotYet,
    /// The target is older than everything the sysvar still holds.
    Expired,
}

/// SlotHashes data: u64 count, then (slot u64, hash [u8; 32]) pairs, newest first.
/// Skipped slots have no entry, so the answer is the first block AT OR AFTER the target.
/// Once the target is older than the oldest entry the answer is `Expired`, never a later
/// block: otherwise waiting out a bad result would be a free re-roll.
pub fn lookup_slot_hash(data: &[u8], target: u64) -> SlotLookup {
    if data.len() < 8 {
        return SlotLookup::NotYet;
    }
    let n = (u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize).min((data.len() - 8) / 40);
    if n == 0 {
        return SlotLookup::NotYet;
    }
    let slot_at = |i: usize| u64::from_le_bytes(data[8 + i * 40..16 + i * 40].try_into().unwrap());
    if slot_at(0) < target {
        return SlotLookup::NotYet;
    }
    if slot_at(n - 1) > target {
        return SlotLookup::Expired;
    }
    // Largest index whose slot is still >= target (entries are newest first).
    let (mut lo, mut hi) = (0usize, n - 1);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if slot_at(mid) >= target {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let mut h = [0u8; 32];
    h.copy_from_slice(&data[16 + lo * 40..48 + lo * 40]);
    SlotLookup::Found(h)
}

/// Lock in every batch whose block has passed. Returns (revealed, expired).
pub fn reveal_matured(ticket: &mut Ticket, slot_hashes: &[u8], current_slot: u64) -> (u32, u32) {
    let (mut revealed, mut expired) = (0u32, 0u32);
    let pool = ticket.pool;
    let user = ticket.user;
    for b in ticket.batches.iter_mut() {
        if b.state != BATCH_WAITING || current_slot <= b.target_slot {
            continue;
        }
        match lookup_slot_hash(slot_hashes, b.target_slot) {
            SlotLookup::Found(h) => {
                b.seed = hashv(&[
                    &h,
                    pool.as_ref(),
                    user.as_ref(),
                    &b.target_slot.to_le_bytes(),
                    &b.first_roll.to_le_bytes(),
                ])
                .to_bytes();
                b.state = BATCH_REVEALED;
                revealed += 1;
            }
            SlotLookup::Expired => {
                b.seed = hashv(&[
                    b"expired",
                    pool.as_ref(),
                    user.as_ref(),
                    &b.target_slot.to_le_bytes(),
                    &b.first_roll.to_le_bytes(),
                ])
                .to_bytes();
                b.state = BATCH_EXPIRED;
                expired += 1;
            }
            SlotLookup::NotYet => {}
        }
    }
    (revealed, expired)
}

/// The 16 seed bytes that go into a piece's URI. Depends only on the batch seed and the
/// piece's roll number, both fixed before the outcome could be known.
pub fn piece_seed(batch: &Batch, roll: u32) -> [u8; 16] {
    let full = hashv(&[&batch.seed, &roll.to_le_bytes()]).to_bytes();
    let mut short = [0u8; 16];
    short.copy_from_slice(&full[..16]);
    if batch.state == BATCH_EXPIRED {
        // Byte 9 is the rarity roll in the renderer; 255 is always the common tier.
        short[9] = 0xFF;
    }
    short
}

// ---- the peg ---------------------------------------------------------------------------------

/// A wallet's associated token account for the coin.
pub fn coins_address(wallet: &Pubkey, token_program: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// The coins that back a wallet's pieces: the balance of its associated token account.
/// Coins kept anywhere else back nothing, and an account that does not exist holds zero.
fn backing(coins: &AccountInfo, cfg: &CollectionConfig, wallet: &Pubkey) -> Result<u64> {
    require_keys_eq!(
        coins.key(),
        coins_address(wallet, &cfg.token_program, &cfg.base_mint),
        CollectibleError::WrongCoins
    );
    if *coins.owner != cfg.token_program || coins.data_len() < 72 {
        return Ok(0);
    }
    let d = coins.try_borrow_data()?;
    // token account: mint, owner, amount
    if d[0..32] != cfg.base_mint.to_bytes() || d[32..64] != wallet.to_bytes() {
        return Ok(0);
    }
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

// ---- the pegged coin: raw views used inside a transfer --------------------------------------

/// The value of a Token-2022 extension in a mint or token account, if it has it.
fn t22_extension(data: &[u8], kind: u16) -> Option<&[u8]> {
    let mut i = T22_ACCOUNT_TYPE + 1;
    while i + 4 <= data.len() {
        let t = u16::from_le_bytes([data[i], data[i + 1]]);
        let len = u16::from_le_bytes([data[i + 2], data[i + 3]]) as usize;
        if t == 0 || i + 4 + len > data.len() {
            return None;
        }
        if t == kind {
            return Some(&data[i + 4..i + 4 + len]);
        }
        i += 4 + len;
    }
    None
}

/// Is this mint a Token-2022 mint whose transfer hook is this program, forever?
fn is_pegged_mint(mint: &AccountInfo) -> bool {
    if *mint.owner != TOKEN_2022_PROGRAM_ID {
        return false;
    }
    let Ok(d) = mint.try_borrow_data() else { return false };
    pegged_mint_bytes(&d)
}
/// The same question on the raw bytes of an account Token-2022 owns.
fn pegged_mint_bytes(d: &[u8]) -> bool {
    if d.len() <= T22_ACCOUNT_TYPE || d.len() == T22_MULTISIG_LEN || d[T22_ACCOUNT_TYPE] != 1 {
        return false;
    }
    // TransferHook { authority, program_id }: the authority must be unset, or the hook could be swapped
    matches!(t22_extension(d, EXT_TRANSFER_HOOK), Some(e) if e.len() == 64 && e[..32] == [0u8; 32] && e[32..] == crate::ID.to_bytes())
}
/// (owning wallet, balance) when these bytes of an account Token-2022 owns are a token
/// account of `mint` in the middle of a transfer.
fn transferring_account_bytes(d: &[u8], mint: &Pubkey) -> Option<(Pubkey, u64)> {
    if d.len() <= T22_ACCOUNT_TYPE || d.len() == T22_MULTISIG_LEN || d[T22_ACCOUNT_TYPE] != 2 || d[0..32] != mint.to_bytes() {
        return None;
    }
    if !matches!(t22_extension(d, EXT_TRANSFER_HOOK_ACCOUNT), Some(f) if !f.is_empty() && f[0] == 1) {
        return None;
    }
    Some((
        Pubkey::new_from_array(d[32..64].try_into().unwrap()),
        u64::from_le_bytes(d[64..72].try_into().unwrap()),
    ))
}

/// One side of a transfer in progress: the wallet that owns the token account and what it
/// holds now. Fails unless the account is a token account of this coin with Token-2022's
/// "transferring" flag set, which only the token program sets, for the length of its call
/// into the hook.
fn transfer_side(account: &AccountInfo, cfg: &CollectionConfig) -> Result<(Pubkey, u64)> {
    require_keys_eq!(*account.owner, cfg.token_program, CollectibleError::NotATransfer);
    let d = account.try_borrow_data()?;
    transferring_account_bytes(&d, &cfg.base_mint).ok_or_else(|| error!(CollectibleError::NotATransfer))
}

/// Is this account the ticket of `wallet` on `pool`? Tickets are only ever created by this
/// program at their PDA, so the contents are proof enough.
fn is_ticket(account: &AccountInfo, pool: &Pubkey, wallet: &Pubkey) -> bool {
    if *account.owner != crate::ID {
        return false;
    }
    let Ok(d) = account.try_borrow_data() else { return false };
    d.len() >= T_OWNED
        && d[..8] == *<Ticket as anchor_lang::Discriminator>::DISCRIMINATOR
        && d[T_POOL..T_POOL + 32] == pool.to_bytes()
        && d[T_USER..T_USER + 32] == wallet.to_bytes()
}

/// Minted pieces in a raw ticket.
pub fn raw_owned(d: &[u8]) -> u32 {
    u32::from_le_bytes(d[T_COUNT..T_COUNT + 4].try_into().unwrap())
}
/// Waiting pieces in a raw ticket.
pub fn raw_pending(d: &[u8]) -> u32 {
    (0..MAX_BATCHES).map(|i| d[T_BATCHES + i * T_BATCH + 1] as u32).sum()
}
/// `cancel_unbacked` on the raw bytes: drop up to `n` waiting pieces, newest batch first,
/// last roll first. Returns how many were dropped.
pub fn raw_drop_pending(d: &mut [u8], n: u32) -> u32 {
    let mut left = n;
    while left > 0 {
        let mut newest: Option<(usize, u32)> = None;
        for i in 0..MAX_BATCHES {
            let at = T_BATCHES + i * T_BATCH;
            if d[at + 1] == 0 {
                continue;
            }
            let roll = u32::from_le_bytes(d[at + 3..at + 7].try_into().unwrap());
            if newest.map(|(_, r)| roll >= r).unwrap_or(true) {
                newest = Some((at, roll));
            }
        }
        let Some((at, _)) = newest else { break };
        let take = (d[at + 1] as u32).min(left);
        d[at + 1] -= take as u8;
        if d[at + 1] == 0 {
            d[at..at + T_BATCH].fill(0);
        }
        left -= take;
    }
    n - left
}
/// Take the last piece off a raw ticket's list.
pub fn raw_pop(d: &mut [u8]) -> Option<[u8; 32]> {
    let n = raw_owned(d) as usize;
    if n == 0 || d.len() < T_OWNED + 32 * n {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&d[T_OWNED + 32 * (n - 1)..T_OWNED + 32 * n]);
    d[T_COUNT..T_COUNT + 4].copy_from_slice(&((n - 1) as u32).to_le_bytes());
    Some(key)
}
/// Put a piece at the end of a raw ticket's list. The account must already be large enough.
pub fn raw_push(d: &mut [u8], key: &[u8; 32]) {
    let n = raw_owned(d) as usize;
    d[T_OWNED + 32 * n..T_OWNED + 32 * (n + 1)].copy_from_slice(key);
    d[T_COUNT..T_COUNT + 4].copy_from_slice(&((n + 1) as u32).to_le_bytes());
}

// ---- the deposit ---------------------------------------------------------------------------

/// The deposit of an account: the lamports it holds above the rent-exempt minimum of its
/// size. For a ticket this is the wallet's own money, paid in with a plain transfer (or left
/// by pieces that moved away); only the wallet's own mints and `withdraw_deposit` take it.
pub fn deposit_of(lamports: u64, data_len: usize, rent: &Rent) -> u64 {
    lamports.saturating_sub(rent.minimum_balance(data_len))
}
fn deposit_in(account: &AccountInfo, rent: &Rent) -> u64 {
    deposit_of(account.lamports(), account.data_len(), rent)
}

/// Shrink a ticket to exactly the bytes a list of `owned` pieces needs (`Ticket::space`, the
/// size its contents serialize to). Its lamports stay where they are: the rent the shrink
/// frees is then above the rent of the new size, which makes it the wallet's deposit, used
/// first by its next mint and returned by `withdraw_deposit`. Never grows, never moves a
/// lamport, never goes below what the list needs. Called after the last CPI of an instruction.
fn shrink_to_fit(ticket: &AccountInfo, owned: usize) -> Result<()> {
    let len = Ticket::space(owned);
    if ticket.data_len() > len {
        ticket.resize(len)?;
    }
    Ok(())
}

/// The size of the Metaplex Core asset of a piece with this name and URI.
pub fn core_asset_len(name: &str, uri: &str) -> usize {
    CORE_ASSET_FIXED_LEN + name.len() + uri.len()
}

/// The least a mint of `n` pieces numbered from `first_number` costs a deposit: the rent of
/// the ticket's growth from `ticket_len` to `ticket_len_after`, the rent of each asset at its
/// exact size, and the keeper fee when asked. Metaplex Core's own create fee is left out: it
/// is Core's to set. This is the check made before anything is created; what the sender
/// really spent is checked after. `None` when the sum does not fit in 64 bits.
#[allow(clippy::too_many_arguments)]
pub fn mint_cost_floor(
    rent: &Rent,
    ticket_len: usize,
    ticket_len_after: usize,
    name: &str,
    uri_len: usize,
    first_number: u32,
    n: u32,
    keeper_fee: u64,
) -> Option<u64> {
    let mut total = rent.minimum_balance(ticket_len_after.max(ticket_len)).checked_sub(rent.minimum_balance(ticket_len))?;
    for i in 0..n {
        let number = first_number.checked_add(i)?;
        // "<name> #<number>": the name, two bytes, the digits
        let digits = number.checked_ilog10().unwrap_or(0) as usize + 1;
        let len = CORE_ASSET_FIXED_LEN + name.len() + 2 + digits + uri_len;
        total = total.checked_add(rent.minimum_balance(len))?;
    }
    total.checked_add(keeper_fee)
}

/// Grow a program-owned account to `len` bytes, paying its extra rent out of `from`, another
/// account of this program that is about to shrink. `keep` is what the growing account holds
/// above its rent-exempt minimum and keeps (a ticket's deposit): the growth is paid in full
/// by `from`. `from_floor` is the least `from` keeps: the rent of its size after the shrink
/// plus its own deposit. So no ticket's deposit ever pays for another one's rent. Never
/// shrinks, never fails: returns false, and changes nothing, when `from` cannot pay or the
/// account cannot grow.
fn grow_from<'info>(account: &AccountInfo<'info>, len: usize, keep: u64, from: &AccountInfo<'info>, from_floor: u64, rent: &Rent) -> bool {
    if account.data_len() >= len {
        return true;
    }
    let short = rent.minimum_balance(len).saturating_add(keep).saturating_sub(account.lamports());
    let spare = from.lamports().saturating_sub(from_floor);
    if spare < short || account.key() == from.key() {
        return false;
    }
    if account.resize(len).is_err() {
        return false;
    }
    if short > 0 {
        if let (Ok(mut a), Ok(mut b)) = (from.try_borrow_mut_lamports(), account.try_borrow_mut_lamports()) {
            **a -= short;
            **b += short;
        }
    }
    true
}

/// Create the ticket of `wallet` on `pool` at its address, paid by `payer`. A ticket that is
/// already open is left exactly as it is. Lamports somebody sent to the address beforehand
/// do not block it; what they hold above the rent becomes the wallet's deposit.
fn create_ticket<'info>(ticket: &AccountInfo<'info>, payer: &AccountInfo<'info>, pool: &Pubkey, wallet: &Pubkey, bump: u8) -> Result<()> {
    use anchor_lang::system_program as sys;
    if *ticket.owner == crate::ID && !ticket.data_is_empty() {
        return Ok(());
    }
    require!(*ticket.owner == sys::ID && ticket.data_is_empty(), CollectibleError::WrongTicket);
    let space = Ticket::space(0);
    let rent = Rent::get()?.minimum_balance(space);
    let seeds: &[&[u8]] = &[TICKET_SEED, pool.as_ref(), wallet.as_ref(), &[bump]];
    if ticket.lamports() == 0 {
        sys::create_account(
            CpiContext::new_with_signer(sys::ID, sys::CreateAccount { from: payer.clone(), to: ticket.clone() }, &[seeds]),
            rent,
            space as u64,
            &crate::ID,
        )?;
    } else {
        let short = rent.saturating_sub(ticket.lamports());
        if short > 0 {
            sys::transfer(CpiContext::new(sys::ID, sys::Transfer { from: payer.clone(), to: ticket.clone() }), short)?;
        }
        sys::allocate(CpiContext::new_with_signer(sys::ID, sys::Allocate { account_to_allocate: ticket.clone() }, &[seeds]), space as u64)?;
        sys::assign(CpiContext::new_with_signer(sys::ID, sys::Assign { account_to_assign: ticket.clone() }, &[seeds]), &crate::ID)?;
    }
    let fresh = Ticket {
        bump,
        pool: *pool,
        user: *wallet,
        minted: 0,
        rolls: 0,
        staged: 0,
        staged_slot: 0,
        batches: [Batch::default(); MAX_BATCHES],
        owned: Vec::new(),
    };
    let mut data = ticket.try_borrow_mut_data()?;
    let mut w: &mut [u8] = &mut data;
    fresh.try_serialize(&mut w)?;
    Ok(())
}

/// Lamports sent to an address this program is about to create would make the create fail
/// forever, for the price of one transfer. Hand them to `to` first. Only an empty,
/// system-owned PDA of this program can be swept, and only with its own seeds.
fn sweep_prefunded<'info>(account: &AccountInfo<'info>, to: &AccountInfo<'info>, seeds: &[&[u8]]) -> Result<()> {
    use anchor_lang::system_program as sys;
    if account.lamports() == 0 || !account.data_is_empty() || *account.owner != sys::ID {
        return Ok(());
    }
    sys::transfer(
        CpiContext::new_with_signer(sys::ID, sys::Transfer { from: account.clone(), to: to.clone() }, &[seeds]),
        account.lamports(),
    )
}

/// Drop the waiting pieces a wallet no longer holds coins for, newest first, and within a
/// batch the last roll first. Returns (pieces dropped, minted pieces still above the peg).
pub fn cancel_unbacked(ticket: &mut Ticket, cfg: &mut CollectionConfig, allowed: u64) -> (u32, u64) {
    let mut excess = ticket.pieces().saturating_sub(allowed);
    let mut dropped = 0u32;
    while excess > 0 {
        let newest = (0..MAX_BATCHES)
            .filter(|i| ticket.batches[*i].pieces > 0)
            .max_by_key(|i| ticket.batches[*i].first_roll);
        let Some(i) = newest else { break };
        let b = &mut ticket.batches[i];
        let take = (b.pieces as u64).min(excess) as u8;
        b.pieces -= take;
        if b.pieces == 0 {
            *b = Batch::default();
        }
        dropped += take as u32;
        excess -= take as u64;
    }
    cfg.reserved_pending = cfg.reserved_pending.saturating_sub(dropped);
    (dropped, excess)
}

/// Move lamports out of an account of this program. Only ever called after the last CPI
/// of an instruction.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    require_keys_neq!(from.key(), to.key(), CollectibleError::WrongTicket);
    let left = from.lamports().checked_sub(amount).ok_or(CollectibleError::DepositTooSmall)?;
    let got = to.lamports().checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = got;
    Ok(())
}

/// The accounts a mint passes to Metaplex Core.
struct MintAccounts<'info> {
    /// Pays the assets' rent: the wallet in `mint`, the sender in `mint_for`.
    payer: AccountInfo<'info>,
    /// The wallet: it owns every piece minted from its ticket.
    owner: AccountInfo<'info>,
    /// Where lamports sent beforehand to a piece's address go.
    strays_to: AccountInfo<'info>,
    collection: AccountInfo<'info>,
    collection_authority: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    core_program: AccountInfo<'info>,
}

/// Mint up to `max` decided pieces of the ticket, batch by batch, into its wallet. The
/// asset accounts are `assets`, in order, starting at the ticket's next index. Returns how
/// many were minted. `mint` and `mint_for` make exactly the same pieces: the seed comes
/// from the batch and the roll, the number from the collection's counter.
#[inline(never)]
fn mint_decided<'info>(
    cfg: &mut CollectionConfig,
    ticket: &mut Ticket,
    assets: &'info [AccountInfo<'info>],
    max: usize,
    a: &MintAccounts<'info>,
) -> Result<u32> {
    let pool = cfg.pool;
    let user = ticket.user;
    require_keys_eq!(a.owner.key(), user, CollectibleError::WrongTicket);
    let mut left = max.min(assets.len());
    let mut used = 0usize;
    for bi in 0..MAX_BATCHES {
        while left > 0 {
            let b = ticket.batches[bi];
            if !(b.state == BATCH_REVEALED || b.state == BATCH_EXPIRED) || b.pieces == 0 {
                break;
            }
            let asset = &assets[used];
            let idx = ticket.minted.to_le_bytes();
            let (expected, asset_bump) = Pubkey::find_program_address(&[ASSET_SEED, pool.as_ref(), user.as_ref(), &idx], &crate::ID);
            require_keys_eq!(asset.key(), expected, CollectibleError::WrongAsset);
            sweep_prefunded(asset, &a.strays_to, &[ASSET_SEED, pool.as_ref(), user.as_ref(), &idx, &[asset_bump]])?;

            let short = piece_seed(&b, b.first_roll + b.minted_from as u32);
            // The number is cosmetic (mint order). It never feeds the seed.
            let number = cfg.minted + 1;
            let name = format!("{} #{}", cfg.name, number);
            let uri = format!("{}/p/{}/{}", cfg.uri_base, hex(&b.art), hex(&short));
            create_core_asset(
                asset,
                &a.collection,
                &a.collection_authority,
                &a.payer,
                &a.owner,
                &a.system_program,
                &a.core_program,
                &pool,
                &idx,
                asset_bump,
                cfg.authority_bump,
                &name,
                &uri,
            )?;

            cfg.minted += 1;
            cfg.live += 1;
            cfg.reserved_pending = cfg.reserved_pending.saturating_sub(1);
            ticket.minted += 1;
            ticket.owned.push(asset.key());
            ticket.staged = 0;
            let batch = &mut ticket.batches[bi];
            batch.pieces -= 1;
            batch.minted_from += 1;
            if batch.pieces == 0 {
                *batch = Batch::default();
            }
            emit!(PieceMinted { pool, user, asset: asset.key(), number, seed: short, art_version: cfg.art_version });
            left -= 1;
            used += 1;
        }
    }
    Ok(used as u32)
}

#[program]
pub mod hook_collectible {
    use super::*;

    pub fn init_manifest(ctx: Context<InitManifest>, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        let m = HookManifestData::new(FLAGS, None, "Programmable collectible", &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;
        // Extra 5: this pool's config. Extra 6: the trader's ticket. Extra 7: SlotHashes.
        let metas = [
            per_pool_config_meta(CFG_SEED, true)?,
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: TICKET_SEED.to_vec() },
                    Seed::AccountKey { index: CB_IDX_POOL },
                    Seed::AccountKey { index: CB_IDX_USER },
                ],
                false,
                true,
            )
            .map_err(|_| InterfaceError::ExtraMetas)?,
            ExtraAccountMeta::new_with_pubkey(&SLOT_HASHES_ID, false, false)
                .map_err(|_| InterfaceError::ExtraMetas)?,
        ];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// Before `create_pool`. Creates the config and the Metaplex Core collection.
    pub fn init_pool_config(ctx: Context<InitPoolConfig>, pool: Pubkey, args: InitCollectionArgs) -> Result<()> {
        require!(!args.name.is_empty() && args.name.len() <= MAX_NAME, CollectibleError::BadName);
        require!(
            !args.uri_base.is_empty() && args.uri_base.len() <= MAX_URI_BASE,
            CollectibleError::BadUriBase
        );
        require!(args.unit > 0, CollectibleError::BadUnit);
        require!(args.max_supply > 0, CollectibleError::BadSupply);
        require!(
            args.max_per_buy >= 1 && args.max_per_buy <= MAX_PER_BUY_CAP,
            CollectibleError::BadMaxPerBuy
        );

        let collection_uri = format!("{}/c/{}", args.uri_base, pool);
        sweep_prefunded(
            &ctx.accounts.collection.to_account_info(),
            &ctx.accounts.payer.to_account_info(),
            &[COLLECTION_SEED, pool.as_ref(), &[ctx.bumps.collection]],
        )?;
        create_core_collection(
            &ctx.accounts.collection.to_account_info(),
            &ctx.accounts.collection_authority.to_account_info(),
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.core_program.to_account_info(),
            &pool,
            ctx.bumps.collection,
            &args.name,
            &collection_uri,
        )?;

        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.authority_bump = ctx.bumps.collection_authority;
        cfg.collection_bump = ctx.bumps.collection;
        cfg.pool = pool;
        cfg.creator = ctx.accounts.payer.key();
        cfg.owner = ctx.accounts.owner.key();
        cfg.collection = ctx.accounts.collection.key();
        cfg.base_mint = Pubkey::default();
        cfg.token_program = Pubkey::default();
        cfg.pegged = false;
        cfg.unit = args.unit;
        cfg.max_supply = args.max_supply;
        cfg.minted = 0;
        cfg.live = 0;
        cfg.reserved_pending = 0;
        cfg.max_per_buy = args.max_per_buy;
        cfg.art_version = 1;
        cfg.art = args.art;
        cfg.name = args.name;
        cfg.uri_base = args.uri_base;
        Ok(())
    }

    /// Bind a pegged coin to this config, before the pool exists. The coin must be a
    /// Token-2022 mint whose transfer hook is this program and can never be changed. The
    /// mint signs: only whoever creates the coin can bind it, and only once. Creates the
    /// account list Token-2022 passes to `execute`, and the pool's burn queue.
    pub fn init_peg(ctx: Context<InitPeg>) -> Result<()> {
        let mint = ctx.accounts.mint.to_account_info();
        let cfg = &mut ctx.accounts.cfg;
        require!(!cfg.pegged && cfg.base_mint == Pubkey::default(), CollectibleError::AlreadyPegged);
        require_keys_eq!(cfg.creator, ctx.accounts.payer.key(), CollectibleError::WrongCreator);
        require_keys_eq!(
            pool_address(&mint.key(), &ctx.accounts.quote_mint.key()).0,
            cfg.pool,
            CollectibleError::WrongPool
        );
        require!(is_pegged_mint(&mint), CollectibleError::BadPegMint);
        cfg.base_mint = mint.key();
        cfg.token_program = TOKEN_2022_PROGRAM_ID;
        cfg.pegged = true;

        // Execute's accounts: 0 source, 1 mint, 2 destination, 3 authority, 4 this list,
        // then 5 config, 6 the sender's ticket, 7 the receiver's ticket, 8 the burn queue.
        // A ticket is [ticket, pool, wallet]: the pool is read from the config (byte 11),
        // the wallet from the token account's owner field (byte 32).
        let ticket_of = |token_account: u8| {
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: TICKET_SEED.to_vec() },
                    Seed::AccountData { account_index: 5, data_index: 11, length: 32 },
                    Seed::AccountData { account_index: token_account, data_index: 32, length: 32 },
                ],
                false,
                true,
            )
            .map_err(|_| InterfaceError::ExtraMetas)
        };
        let metas = [
            ExtraAccountMeta::new_with_pubkey(&cfg.key(), false, true).map_err(|_| InterfaceError::ExtraMetas)?,
            ticket_of(0)?,
            ticket_of(2)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.queue.key(), false, true).map_err(|_| InterfaceError::ExtraMetas)?,
        ];
        let mut data = ctx.accounts.validation.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas).map_err(|_| InterfaceError::ExtraMetas)?;

        ctx.accounts.queue.pool = cfg.pool;
        ctx.accounts.queue.count = 0;
        Ok(())
    }

    /// Token-2022 calls this on every transfer of a pegged coin, after the balances moved.
    /// uPEG's `_afterTokenTransfer`: the pieces the sender's coins no longer back leave the
    /// sender, from the end of its list. They go to the receiver while it has a ticket and
    /// this transfer added whole units to its associated token account, one piece per unit
    /// added; the rest is burned. A transfer out of the pool is a buy and moves nothing.
    ///
    /// This runs inside every transfer, also inside every sell, so it makes no CPI, reads
    /// the tickets as raw bytes, and answers `Ok` to everything that is a real transfer.
    #[instruction(discriminator = [105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        require!(cfg.pegged, CollectibleError::NotATransfer);
        require_keys_eq!(ctx.accounts.mint.key(), cfg.base_mint, CollectibleError::NotATransfer);
        let (from, from_balance) = transfer_side(&ctx.accounts.source.to_account_info(), cfg)?;
        let (to, to_balance) = transfer_side(&ctx.accounts.destination.to_account_info(), cfg)?;

        // coins leaving the pool: a buy (or liquidity coming back). Nothing moves.
        if from == cfg.pool {
            return Ok(());
        }
        let ft = ctx.accounts.from_ticket.to_account_info();
        if !is_ticket(&ft, &cfg.pool, &from) {
            return Ok(());
        }
        let to_pool = to == cfg.pool;
        // A stage is spent by the wallet's first transfer, whatever that transfer is: a sell,
        // a transfer out of another of its accounts, or one that moves nothing.
        let (owned, pending, staged) = {
            let mut d = ft.try_borrow_mut_data()?;
            let mut staged = 0u32;
            if d[T_STAGED] > 0 {
                let slot = u64::from_le_bytes(d[T_STAGED_SLOT..T_STAGED_SLOT + 8].try_into().unwrap());
                if Clock::get().map(|c| c.slot == slot).unwrap_or(false) {
                    staged = d[T_STAGED] as u32;
                }
                d[T_STAGED] = 0;
            }
            (raw_owned(&d), raw_pending(&d), staged)
        };
        if owned + pending == 0 {
            return Ok(());
        }
        // only the wallet's associated token account backs its pieces
        if ctx.accounts.source.key() != coins_address(&from, &cfg.token_program, &cfg.base_mint) {
            return Ok(());
        }
        let unit = cfg.unit.max(1);
        // a staged piece travels with its coins: one per whole unit sent, and never into the pool
        let staged = if to_pool { 0 } else { staged.min(owned).min((amount / unit).min(u32::MAX as u64) as u32) };
        let excess_total = ((owned + pending) as u64).saturating_sub(from_balance / unit) as u32;
        if excess_total == 0 && staged == 0 {
            return Ok(());
        }
        let Ok(rent) = Rent::get() else { return Ok(()) };
        // what each wallet holds above the rent is its deposit: it stays with that wallet
        let from_deposit = deposit_in(&ft, &rent);

        // 1. What the receiver can take: one piece per whole unit THIS transfer sent to its
        //    associated token account, within what its coins back and the cap. The coins it
        //    held before stay free for its own pieces, and dust that happens to complete a
        //    unit carries nothing: nobody fills another wallet's list for less than a unit.
        let tt = ctx.accounts.to_ticket.to_account_info();
        let mut room = 0u32;
        if !to_pool
            && tt.key() != ft.key()
            && is_ticket(&tt, &cfg.pool, &to)
            && ctx.accounts.destination.key() == coins_address(&to, &cfg.token_program, &cfg.base_mint)
        {
            let d = tt.try_borrow_data()?;
            let theirs = (raw_owned(&d) + raw_pending(&d)) as u64;
            let backed = to_balance / unit;
            room = (amount / unit)
                .min(backed.saturating_sub(theirs))
                .min((MAX_PIECES_PER_WALLET as u64).saturating_sub(theirs)) as u32;
        }

        // 2. Staged pieces that travel take their own coins with them, so the coins that stay
        //    still back what stays. Only what is unbacked after that goes: waiting pieces are
        //    dropped first, then minted pieces leave.
        let staged_out = staged.min(room);
        let dropped = {
            let mut d = ft.try_borrow_mut_data()?;
            raw_drop_pending(&mut d, excess_total.saturating_sub(staged_out).min(pending))
        };
        cfg.reserved_pending = cfg.reserved_pending.saturating_sub(dropped);
        // minted pieces that leave because no coins back them any more (the staged ones among them)
        let excess = excess_total.saturating_sub(dropped).min(owned);
        let mut moved = excess.max(staged_out).min(room);
        let mut burned = excess.saturating_sub(moved);

        // 3. A piece takes the rent of its 32 bytes with it: out of the sender's ticket, into
        //    the receiver's ticket or the burn queue. Both grow BEFORE anything leaves the
        //    list, so a piece that finds no place stays where it is.
        let queue = ctx.accounts.queue.to_account_info();
        let queued = if *queue.owner == crate::ID {
            let d = queue.try_borrow_data()?;
            if d.len() >= Q_ENTRIES && d[Q_POOL..Q_POOL + 32] == cfg.pool.to_bytes() {
                Some(u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize)
            } else {
                None
            }
        } else {
            None
        };
        if moved > 0 {
            let theirs = raw_owned(&tt.try_borrow_data()?) as usize;
            let to_deposit = deposit_in(&tt, &rent);
            let floor = rent.minimum_balance(Ticket::space((owned - moved) as usize)).saturating_add(from_deposit);
            if !grow_from(&tt, Ticket::space(theirs + moved as usize), to_deposit, &ft, floor, &rent) {
                // no place at the receiver: nothing moves. What the coins no longer back
                // burns; a staged piece, still backed, stays.
                moved = 0;
                burned = excess;
            }
        }
        if burned > 0 {
            let fits = match queued {
                // the queue is nobody's: what it holds above its rent pays first
                Some(n) if n + burned as usize <= MAX_QUEUE => grow_from(
                    &queue,
                    Q_ENTRIES + 32 * (n + burned as usize),
                    0,
                    &ft,
                    rent.minimum_balance(Ticket::space((owned - moved - burned) as usize)).saturating_add(from_deposit),
                    &rent,
                ),
                _ => false,
            };
            // A full queue: the pieces stay on the sender's list, above the peg, and anyone's
            // `settle` burns them. The transfer itself never fails for it.
            if !fits {
                burned = 0;
            }
        }

        // 4. the pieces leave the end of the sender's list
        let mut leaving: Vec<[u8; 32]> = Vec::with_capacity((moved + burned) as usize);
        {
            let mut d = ft.try_borrow_mut_data()?;
            for _ in 0..moved + burned {
                match raw_pop(&mut d) {
                    Some(k) => leaving.push(k),
                    None => break,
                }
            }
        }
        let moved = (moved as usize).min(leaving.len());
        if moved > 0 {
            let mut d = tt.try_borrow_mut_data()?;
            for k in &leaving[..moved] {
                raw_push(&mut d, k);
            }
            // the end of the receiver's list changed: a stage it made no longer names it
            d[T_STAGED] = 0;
        }
        let to_burn = &leaving[moved..];
        if !to_burn.is_empty() {
            let n = queued.unwrap_or(0);
            let mut d = queue.try_borrow_mut_data()?;
            for (i, k) in to_burn.iter().enumerate() {
                d[Q_ENTRIES + 32 * (n + i)..Q_ENTRIES + 32 * (n + i + 1)].copy_from_slice(k);
            }
            d[Q_COUNT..Q_COUNT + 4].copy_from_slice(&((n + to_burn.len()) as u32).to_le_bytes());
        }
        // the sender's ticket gives its spare bytes back; a failure here would only leave it longer
        let _ = ft.resize(Ticket::space(owned as usize - leaving.len()));
        cfg.live = cfg.live.saturating_sub(to_burn.len() as u32);
        emit!(PiecesTransferred { pool: cfg.pool, from, to, dropped, moved: moved as u32, burned: to_burn.len() as u32 });
        Ok(())
    }

    /// Hand the Metaplex Core assets of pieces that moved in a transfer to the wallet whose
    /// list now holds them. Anyone may send it. The assets go in remaining accounts; one
    /// that is not in this ticket's list, or is already with its holder, is skipped.
    pub fn deliver<'info>(ctx: Context<'info, Deliver<'info>>) -> Result<()> {
        let pool = ctx.accounts.cfg.pool;
        let holder = ctx.accounts.ticket.user;
        for asset in ctx.remaining_accounts.iter() {
            if !ctx.accounts.ticket.owned.contains(&asset.key()) || *asset.owner != MPL_CORE_ID {
                continue;
            }
            let with_holder = {
                let d = asset.try_borrow_data()?;
                d.len() >= 33 && d[0] == 1 && d[1..33] == holder.to_bytes()
            };
            if with_holder {
                continue;
            }
            transfer_core_asset(
                asset,
                &ctx.accounts.collection.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.collection_authority.to_account_info(),
                &ctx.accounts.holder.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.core_program.to_account_info(),
                &pool,
                ctx.accounts.cfg.authority_bump,
            )?;
            emit!(PieceDelivered { pool, asset: asset.key(), to: holder, by: ctx.accounts.payer.key() });
        }
        Ok(())
    }

    /// Burn the Metaplex Core assets of pieces a pegged coin's transfers burned. Anyone may
    /// send it and receives their rent. The assets go in remaining accounts; one that is
    /// not in the burn queue is skipped.
    pub fn reap<'info>(ctx: Context<'info, Reap<'info>>) -> Result<()> {
        let pool = ctx.accounts.cfg.pool;
        let queue = ctx.accounts.queue.to_account_info();
        require!(queue.data_len() >= Q_ENTRIES, CollectibleError::WrongQueue);
        for asset in ctx.remaining_accounts.iter() {
            let key = asset.key().to_bytes();
            let (at, n) = {
                let d = queue.try_borrow_data()?;
                let n = u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
                // newest first: a reap sent with the transfer finds its piece at once
                ((0..n).rev().find(|i| d[Q_ENTRIES + 32 * i..Q_ENTRIES + 32 * (i + 1)] == key), n)
            };
            let Some(at) = at else { continue };
            burn_core_asset(
                asset,
                &ctx.accounts.collection.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.collection_authority.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.core_program.to_account_info(),
                &pool,
                ctx.accounts.cfg.authority_bump,
            )?;
            let mut d = queue.try_borrow_mut_data()?;
            if at != n - 1 {
                d.copy_within(Q_ENTRIES + 32 * (n - 1)..Q_ENTRIES + 32 * n, Q_ENTRIES + 32 * at);
            }
            d[Q_COUNT..Q_COUNT + 4].copy_from_slice(&((n - 1) as u32).to_le_bytes());
            emit!(PieceBurned { pool, user: Pubkey::default(), asset: asset.key(), by: ctx.accounts.payer.key() });
        }
        // the queue gives back the rent of the entries that left. Last, after every CPI.
        let n = u32::from_le_bytes(queue.try_borrow_data()?[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
        let len = Q_ENTRIES + 32 * n;
        if queue.data_len() > len {
            queue.resize(len)?;
            let spare = queue.lamports().saturating_sub(Rent::get()?.minimum_balance(len));
            **queue.try_borrow_mut_lamports()? -= spare;
            **ctx.accounts.payer.to_account_info().try_borrow_mut_lamports()? += spare;
        }
        Ok(())
    }

    /// Pegged coins: send chosen pieces with exactly their coins, uPEG's `transferUpeg`.
    /// The holder puts the pieces at the end of its list, stages `count` of them, and
    /// transfers `unit` coins for each in the same transaction: the hook moves the staged
    /// pieces to the receiver even though the sender's coins would still back them. One
    /// staged piece travels per whole unit sent. The stage holds for this slot only and is
    /// spent by the wallet's first transfer. A staged piece is never burned for being
    /// staged: without room at the receiver it stays.
    ///
    /// The pieces to send go in remaining accounts, in list order. If the end of the list
    /// is not exactly them, nothing is staged and the transaction fails, so a piece that
    /// reached the list in the meantime can never travel in their place.
    pub fn stage<'info>(ctx: Context<'info, Stage<'info>>, count: u8) -> Result<()> {
        require!(ctx.accounts.cfg.pegged, CollectibleError::NotPeggedCoin);
        let balance = backing(&ctx.accounts.coins.to_account_info(), &ctx.accounts.cfg, &ctx.accounts.user.key())?;
        require!(
            ctx.accounts.ticket.pieces() <= balance / ctx.accounts.cfg.unit,
            CollectibleError::AboveThePeg
        );
        require!(count as usize <= ctx.accounts.ticket.owned.len(), CollectibleError::BadCount);
        require!(ctx.remaining_accounts.len() == count as usize, CollectibleError::BadCount);
        let owned = &ctx.accounts.ticket.owned;
        for (named, held) in ctx.remaining_accounts.iter().zip(&owned[owned.len() - count as usize..]) {
            require_keys_eq!(named.key(), *held, CollectibleError::NotStaged);
        }
        let t = &mut ctx.accounts.ticket;
        t.staged = count;
        t.staged_slot = Clock::get()?.slot;
        Ok(())
    }

    /// Open the ticket of any wallet, paid by whoever sends this. A wallet needs a ticket
    /// to receive pieces in a transfer of a pegged coin.
    pub fn open_ticket_for(ctx: Context<OpenTicketFor>, pool: Pubkey, wallet: Pubkey) -> Result<()> {
        create_ticket(
            &ctx.accounts.ticket.to_account_info(),
            &ctx.accounts.payer.to_account_info(),
            &pool,
            &wallet,
            ctx.bumps.ticket,
        )
    }

    /// The buyer creates their ticket for a pool, once. Without it a buy earns nothing.
    /// Opening a ticket that is already open does nothing, so a ticket somebody else opened
    /// for this wallet first never makes the wallet's own transaction fail.
    pub fn open_ticket(ctx: Context<OpenTicket>, pool: Pubkey) -> Result<()> {
        create_ticket(
            &ctx.accounts.ticket.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            &pool,
            &ctx.accounts.user.key(),
            ctx.bumps.ticket,
        )
    }

    /// Anyone may lock in the outcome of anyone's ticket once its block has passed. The
    /// watcher does this for every ticket, so nobody can sit on an unrevealed result.
    pub fn reveal(ctx: Context<Reveal>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let sh = ctx.accounts.slot_hashes.try_borrow_data()?;
        let t = &mut ctx.accounts.ticket;
        let before: Vec<(u8, u64)> = t.batches.iter().map(|b| (b.state, b.target_slot)).collect();
        reveal_matured(t, &sh, slot);
        for (i, b) in t.batches.iter().enumerate() {
            if before[i].0 == BATCH_WAITING && b.state != BATCH_WAITING {
                emit!(BatchRevealed { pool: t.pool, user: t.user, target_slot: b.target_slot, expired: b.state == BATCH_EXPIRED });
            }
        }
        Ok(())
    }

    /// Reveal what can be revealed, then mint up to `count` decided pieces. A no-op when
    /// none are decided yet. Waiting pieces the wallet no longer holds the coins for are
    /// dropped first, so nothing unbacked is ever minted. The asset accounts go in
    /// remaining accounts. The wallet pays the rent, and is paid back what the assets cost
    /// out of its deposit, as far as the deposit goes: a wallet that deposited in its buy
    /// and then mints itself never pays twice.
    pub fn mint<'info>(ctx: Context<'info, MintPieces<'info>>, count: u8) -> Result<()> {
        let pool = ctx.accounts.cfg.pool;
        let user = ctx.accounts.user.key();
        {
            let slot = Clock::get()?.slot;
            let sh = ctx.accounts.slot_hashes.try_borrow_data()?;
            reveal_matured(&mut ctx.accounts.ticket, &sh, slot);
        }
        {
            let balance = backing(&ctx.accounts.coins.to_account_info(), &ctx.accounts.cfg, &user)?;
            let allowed = balance / ctx.accounts.cfg.unit;
            let (dropped, _) = cancel_unbacked(&mut ctx.accounts.ticket, &mut ctx.accounts.cfg, allowed);
            if dropped > 0 {
                emit!(PiecesCancelled { pool, user, pieces: dropped });
            }
        }
        let max = (count.min(MAX_MINT_PER_CALL) as usize).min(ctx.remaining_accounts.len());
        let user_info = ctx.accounts.user.to_account_info();
        let t_info = ctx.accounts.ticket.to_account_info();
        let accounts = MintAccounts {
            payer: user_info.clone(),
            owner: user_info.clone(),
            strays_to: user_info.clone(),
            collection: ctx.accounts.collection.to_account_info(),
            collection_authority: ctx.accounts.collection_authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            core_program: ctx.accounts.core_program.to_account_info(),
        };
        let before = user_info.lamports();
        let minted = mint_decided(&mut ctx.accounts.cfg, &mut ctx.accounts.ticket, ctx.remaining_accounts, max, &accounts)?;
        let spent = before.saturating_sub(user_info.lamports());
        // After the Core calls, the ticket grows to hold exactly the pieces minted: its
        // deposit pays first, the wallet the rest. Never more than it needs, so a deposit
        // never turns into the rent of bytes nobody uses.
        let rent = Rent::get()?;
        let len = Ticket::space(ctx.accounts.ticket.owned.len());
        if t_info.data_len() < len {
            let short = rent.minimum_balance(len).saturating_sub(t_info.lamports());
            if short > 0 {
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        anchor_lang::system_program::ID,
                        anchor_lang::system_program::Transfer { from: user_info.clone(), to: t_info.clone() },
                    ),
                    short,
                )?;
            }
            t_info.resize(len)?;
        }
        // Last, after every CPI: what the assets cost the wallet comes back out of its deposit.
        if spent > 0 {
            let deposit = deposit_in(&t_info, &rent);
            let paid = spent.min(deposit);
            if paid > 0 {
                move_lamports(&t_info, &user_info, paid)?;
                emit!(DepositUsed { pool, user, by: user, pieces: minted, paid, left: deposit - paid });
            }
        }
        Ok(())
    }

    /// Anyone may mint a wallet's decided pieces INTO THAT WALLET, paid by the wallet's
    /// deposit (what its ticket holds above the rent, sent in with the buy). Same checks as
    /// `mint`: what can be revealed is revealed, waiting pieces the wallet's coins no longer
    /// back are dropped, and the pieces are exactly what `mint` would make; nothing about
    /// them depends on who sends this or when. It mints every decided piece, up to four, and
    /// needs that many asset addresses. The sender pays the Metaplex rent and is paid back,
    /// out of the deposit, exactly what it spent plus `KEEPER_FEE`; the ticket's growth stays
    /// in the ticket, paid by the deposit. A deposit that does not cover all of it is
    /// refused (`DepositTooSmall`) and nothing is created.
    pub fn mint_for<'info>(ctx: Context<'info, MintFor<'info>>) -> Result<()> {
        let pool = ctx.accounts.cfg.pool;
        let user = ctx.accounts.user.key();
        let rent = Rent::get()?;
        {
            let slot = Clock::get()?.slot;
            let sh = ctx.accounts.slot_hashes.try_borrow_data()?;
            reveal_matured(&mut ctx.accounts.ticket, &sh, slot);
        }
        {
            let balance = backing(&ctx.accounts.coins.to_account_info(), &ctx.accounts.cfg, &user)?;
            let allowed = balance / ctx.accounts.cfg.unit;
            let (dropped, _) = cancel_unbacked(&mut ctx.accounts.ticket, &mut ctx.accounts.cfg, allowed);
            if dropped > 0 {
                emit!(PiecesCancelled { pool, user, pieces: dropped });
            }
        }
        // every decided piece, up to four: the pieces of one buy cannot be split into many fees
        let decided: u32 = ctx
            .accounts
            .ticket
            .batches
            .iter()
            .filter(|b| b.state == BATCH_REVEALED || b.state == BATCH_EXPIRED)
            .map(|b| b.pieces as u32)
            .sum();
        let n = decided.min(MAX_MINT_PER_CALL as u32);
        require!(n > 0, CollectibleError::NothingToMint);
        require!(ctx.remaining_accounts.len() >= n as usize, CollectibleError::TooFewAssets);

        let t_info = ctx.accounts.ticket.to_account_info();
        let len_before = t_info.data_len();
        let len_after = Ticket::space(ctx.accounts.ticket.owned.len() + n as usize).max(len_before);
        // Before anything is created: the deposit covers at least the rent of all of it.
        let floor = {
            let cfg = &ctx.accounts.cfg;
            let first = cfg.minted.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
            mint_cost_floor(&rent, len_before, len_after, &cfg.name, cfg.uri_base.len() + 68, first, n, KEEPER_FEE)
                .ok_or(ProgramError::ArithmeticOverflow)?
        };
        require!(deposit_in(&t_info, &rent) >= floor, CollectibleError::DepositTooSmall);

        let payer_info = ctx.accounts.payer.to_account_info();
        let accounts = MintAccounts {
            payer: payer_info.clone(),
            owner: ctx.accounts.user.to_account_info(),
            // lamports somebody sent to a piece's address go to the wallet's deposit
            strays_to: t_info.clone(),
            collection: ctx.accounts.collection.to_account_info(),
            collection_authority: ctx.accounts.collection_authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            core_program: ctx.accounts.core_program.to_account_info(),
        };
        let before = payer_info.lamports();
        let minted = mint_decided(&mut ctx.accounts.cfg, &mut ctx.accounts.ticket, ctx.remaining_accounts, n as usize, &accounts)?;
        require!(minted == n, CollectibleError::TooFewAssets);

        // Last, after every CPI. The ticket grows; its new rent is already in it (the deposit).
        if len_after > t_info.data_len() {
            t_info.resize(len_after)?;
        }
        // Exactly what the sender spent (rent and Metaplex Core's fee, nothing else touches
        // its lamports here), plus the fee. The ticket never goes below its rent.
        let spent = before.saturating_sub(payer_info.lamports());
        let paid = spent.checked_add(KEEPER_FEE).ok_or(ProgramError::ArithmeticOverflow)?;
        let deposit = deposit_in(&t_info, &rent);
        require!(deposit >= paid, CollectibleError::DepositTooSmall);
        move_lamports(&t_info, &payer_info, paid)?;
        emit!(DepositUsed { pool, user, by: payer_info.key(), pieces: minted, paid, left: deposit - paid });
        Ok(())
    }

    /// The wallet takes its whole deposit back: everything its ticket holds above the rent.
    /// A ticket longer than its list (one an older version of this program grew for more
    /// pieces than it minted, or one whose pieces left before tickets shrank) first shrinks
    /// to fit, so the rent of the bytes nobody uses comes back too.
    pub fn withdraw_deposit(ctx: Context<WithdrawDeposit>) -> Result<()> {
        let t_info = ctx.accounts.ticket.to_account_info();
        shrink_to_fit(&t_info, ctx.accounts.ticket.owned.len())?;
        let lamports = deposit_in(&t_info, &Rent::get()?);
        require!(lamports > 0, CollectibleError::NoDeposit);
        move_lamports(&t_info, &ctx.accounts.user.to_account_info(), lamports)?;
        emit!(DepositWithdrawn { pool: ctx.accounts.ticket.pool, user: ctx.accounts.user.key(), lamports });
        Ok(())
    }

    /// Anyone may settle any wallet. A wallet holds at most one piece per `unit` coins in
    /// its token account. What is above that is removed, newest first: waiting pieces are
    /// dropped, then minted pieces are burned from the end of the wallet's list. The
    /// assets that may burn go in remaining accounts, in any order: the program burns the
    /// last piece of the list while it finds it there and the wallet is above the peg,
    /// and stops otherwise. Nothing else is ever burned. The rent of a burned piece's
    /// asset goes to whoever sends this. The ticket then shrinks to its list: the rent of
    /// the bytes the burned pieces took stays in the ticket, as the wallet's deposit, and
    /// none of it goes to the sender.
    pub fn settle<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
        let pool = ctx.accounts.cfg.pool;
        let user = ctx.accounts.ticket.user;
        let balance = backing(&ctx.accounts.coins.to_account_info(), &ctx.accounts.cfg, &user)?;
        let allowed = balance / ctx.accounts.cfg.unit;
        let (dropped, mut excess) = cancel_unbacked(&mut ctx.accounts.ticket, &mut ctx.accounts.cfg, allowed);
        if dropped > 0 {
            emit!(PiecesCancelled { pool, user, pieces: dropped });
        }
        while excess > 0 {
            let Some(last) = ctx.accounts.ticket.owned.last().copied() else { break };
            let Some(asset) = ctx.remaining_accounts.iter().find(|a| a.key() == last) else { break };
            burn_core_asset(
                asset,
                &ctx.accounts.collection.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.collection_authority.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.core_program.to_account_info(),
                &pool,
                ctx.accounts.cfg.authority_bump,
            )?;
            ctx.accounts.ticket.owned.pop();
            ctx.accounts.cfg.live = ctx.accounts.cfg.live.saturating_sub(1);
            excess -= 1;
            emit!(PieceBurned { pool, user, asset: last, by: ctx.accounts.payer.key() });
        }
        // Last, after every CPI: the freed bytes' rent becomes the wallet's deposit.
        shrink_to_fit(&ctx.accounts.ticket.to_account_info(), ctx.accounts.ticket.owned.len())
    }

    /// The wallet's own order: the piece at `from` goes to `to`, the others shift. Burns
    /// take from the end, so the pieces to keep go first. Only a wallet whose coins back
    /// all its pieces may reorder: a wallet above the peg cannot shuffle its list to dodge
    /// a settle.
    pub fn reorder(ctx: Context<Reorder>, from: u32, to: u32) -> Result<()> {
        let balance = backing(&ctx.accounts.coins.to_account_info(), &ctx.accounts.cfg, &ctx.accounts.user.key())?;
        require!(
            ctx.accounts.ticket.pieces() <= balance / ctx.accounts.cfg.unit,
            CollectibleError::AboveThePeg
        );
        ctx.accounts.ticket.staged = 0;
        let owned = &mut ctx.accounts.ticket.owned;
        let n = owned.len() as u32;
        require!(from < n && to < n, CollectibleError::BadIndex);
        let piece = owned.remove(from as usize);
        owned.insert(to as usize, piece);
        Ok(())
    }

    /// Move pieces to another wallet together with the coins behind them: `unit` coins per
    /// piece. A piece never travels without its coins. The pieces go in remaining accounts;
    /// the receiving wallet's ticket is opened here if it has none, and grows at the
    /// sender's cost. The sender's ticket shrinks to its list; the rent it frees stays in it,
    /// as the sender's deposit.
    pub fn send_pieces<'info>(ctx: Context<'info, SendPieces<'info>>) -> Result<()> {
        // a pegged coin moves its pieces in the transfer itself; doing both would move twice
        require!(!ctx.accounts.cfg.pegged, CollectibleError::UseTransfer);
        let n = ctx.remaining_accounts.len();
        require!(n >= 1 && n <= MAX_SEND, CollectibleError::BadCount);
        let pool = ctx.accounts.cfg.pool;
        let from = ctx.accounts.user.key();
        let to = ctx.accounts.to.key();
        require_keys_neq!(from, to, CollectibleError::SameWallet);
        let unit = ctx.accounts.cfg.unit;
        let token_program = ctx.accounts.cfg.token_program;
        let base_mint = ctx.accounts.cfg.base_mint;
        require_keys_eq!(ctx.accounts.from_coins.key(), coins_address(&from, &token_program, &base_mint), CollectibleError::WrongCoins);
        require_keys_eq!(ctx.accounts.to_coins.key(), coins_address(&to, &token_program, &base_mint), CollectibleError::WrongCoins);
        // only a backed wallet sends: what a wallet above the peg loses is decided by its
        // list as it stands, not by what it moves out afterwards
        {
            let balance = backing(&ctx.accounts.from_coins.to_account_info(), &ctx.accounts.cfg, &from)?;
            require!(ctx.accounts.ticket.pieces() <= balance / unit, CollectibleError::AboveThePeg);
        }

        // the coins go first
        let decimals = {
            let d = ctx.accounts.mint.try_borrow_data()?;
            require!(d.len() > 44, CollectibleError::WrongCoins);
            d[44]
        };
        transfer_coins(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.from_coins.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.to_coins.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            unit.checked_mul(n as u64).ok_or(CollectibleError::BadCount)?,
            decimals,
        )?;

        // the receiving wallet's list
        let to_info = ctx.accounts.to_ticket.to_account_info();
        let payer = ctx.accounts.user.to_account_info();
        let system = ctx.accounts.system_program.to_account_info();
        let mut theirs = if to_info.data_is_empty() {
            create_ticket_account(&to_info, &payer, &pool, &to, ctx.bumps.to_ticket, Ticket::space(n))?;
            Ticket { bump: ctx.bumps.to_ticket, pool, user: to, minted: 0, rolls: 0, staged: 0, staged_slot: 0, batches: [Batch::default(); MAX_BATCHES], owned: Vec::new() }
        } else {
            require_keys_eq!(*to_info.owner, crate::ID, CollectibleError::WrongTicket);
            let data = to_info.try_borrow_data()?;
            let t = Ticket::try_deserialize(&mut &data[..])?;
            require!(t.pool == pool && t.user == to, CollectibleError::WrongTicket);
            t
        };
        require!(theirs.pieces() as usize + n <= MAX_PIECES_PER_WALLET, CollectibleError::ListFull);

        for asset in ctx.remaining_accounts.iter() {
            let at = ctx
                .accounts
                .ticket
                .owned
                .iter()
                .position(|k| *k == asset.key())
                .ok_or(CollectibleError::NotHeld)?;
            transfer_core_asset(
                asset,
                &ctx.accounts.collection.to_account_info(),
                &payer,
                &ctx.accounts.collection_authority.to_account_info(),
                &ctx.accounts.to.to_account_info(),
                &system,
                &ctx.accounts.core_program.to_account_info(),
                &pool,
                ctx.accounts.cfg.authority_bump,
            )?;
            ctx.accounts.ticket.owned.remove(at);
            theirs.owned.push(asset.key());
            emit!(PieceSent { pool, from, to, asset: asset.key() });
        }

        // grow the receiving ticket if it has to, paid by the sender in full: what the
        // receiver holds above its rent is its deposit and stays its own
        let needed = Ticket::space(theirs.owned.len());
        if to_info.data_len() < needed {
            let rent = Rent::get()?;
            let keep = deposit_in(&to_info, &rent);
            let short = rent.minimum_balance(needed).saturating_add(keep).saturating_sub(to_info.lamports());
            if short > 0 {
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        anchor_lang::system_program::ID,
                        anchor_lang::system_program::Transfer { from: payer.clone(), to: to_info.clone() },
                    ),
                    short,
                )?;
            }
            to_info.resize(needed)?;
        }
        {
            let mut data = to_info.try_borrow_mut_data()?;
            let mut w: &mut [u8] = &mut data;
            theirs.try_serialize(&mut w)?;
        }
        // Last, after every CPI: the sender's ticket gives back the bytes of the pieces that
        // left. Their rent stays in it, as the sender's deposit.
        shrink_to_fit(&ctx.accounts.ticket.to_account_info(), ctx.accounts.ticket.owned.len())
    }

    /// Owner only, while not locked. Changes apply to pieces minted from now on.
    pub fn update_collection(ctx: Context<UpdateCollection>, args: UpdateCollectionArgs) -> Result<()> {
        let pool = ctx.accounts.cfg.pool;
        if let Some(name) = &args.name {
            require!(!name.is_empty() && name.len() <= MAX_NAME, CollectibleError::BadName);
        }
        if let Some(u) = &args.uri_base {
            require!(!u.is_empty() && u.len() <= MAX_URI_BASE, CollectibleError::BadUriBase);
        }
        let new_collection_uri = args.uri_base.as_ref().map(|u| format!("{}/c/{}", u, pool));
        if args.name.is_some() || new_collection_uri.is_some() {
            update_core_collection(
                &ctx.accounts.collection.to_account_info(),
                &ctx.accounts.owner.to_account_info(),
                &ctx.accounts.collection_authority.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.core_program.to_account_info(),
                &pool,
                ctx.accounts.cfg.authority_bump,
                args.name.as_deref(),
                new_collection_uri.as_deref(),
            )?;
        }
        let cfg = &mut ctx.accounts.cfg;
        if let Some(name) = args.name {
            cfg.name = name;
        }
        let mut art_changed = false;
        if let Some(u) = args.uri_base {
            cfg.uri_base = u;
            art_changed = true;
        }
        if let Some(a) = args.art {
            cfg.art = a;
            art_changed = true;
        }
        if art_changed {
            cfg.art_version = cfg.art_version.saturating_add(1);
        }
        emit!(CollectionUpdated { pool, owner: cfg.owner, art_version: cfg.art_version, locked: false });
        Ok(())
    }

    /// Pass Pubkey::default() to lock the collection forever.
    pub fn set_owner(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        cfg.owner = new_owner;
        emit!(CollectionUpdated {
            pool: cfg.pool,
            owner: new_owner,
            art_version: cfg.art_version,
            locked: new_owner == Pubkey::default(),
        });
        Ok(())
    }

    // ---- callbacks from the pool program --------------------------------------

    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        // The Pool account is written by the pool program alone: the hook, the creator and
        // the coin are taken from it, not from the payload's word.
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require_keys_eq!(ctx.accounts.cfg.pool, ctx.accounts.pool.key(), CollectibleError::WrongPool);
        require_keys_eq!(pool.hook_program, crate::ID, CollectibleError::WrongHook);
        require_keys_eq!(ctx.accounts.cfg.creator, payload.creator, CollectibleError::WrongCreator);
        require_keys_eq!(ctx.accounts.cfg.creator, pool.creator, CollectibleError::WrongCreator);
        require_keys_eq!(ctx.accounts.base_mint.key(), pool.base_mint, CollectibleError::WrongPool);
        // the coin whose balances back the pieces
        let mint = ctx.accounts.base_mint.to_account_info();
        let cfg = &mut ctx.accounts.cfg;
        if cfg.pegged || is_pegged_mint(&mint) {
            // a pegged coin was bound to its config by init_peg and trades in that pool only
            require!(cfg.pegged && cfg.base_mint == mint.key(), CollectibleError::NotPegged);
        } else {
            cfg.base_mint = mint.key();
            cfg.token_program = *mint.owner;
        }
        Ok(())
    }

    pub fn after_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        if payload.direction != DIRECTION_BUY {
            return Ok(());
        }
        require_keys_eq!(ctx.accounts.cfg.pool, ctx.accounts.pool.key(), CollectibleError::WrongPool);

        // No ticket, no piece. Never a failed trade.
        let t_info = ctx.accounts.ticket.to_account_info();
        if *t_info.owner != crate::ID || t_info.data_is_empty() {
            return Ok(());
        }
        let mut ticket = {
            let data = t_info.try_borrow_data()?;
            Ticket::try_deserialize(&mut &data[..])?
        };
        if ticket.pool != ctx.accounts.pool.key() || ticket.user != ctx.accounts.user.key() {
            return Ok(());
        }

        // 1. Before anything is added: lock in every batch whose block has passed, so a
        //    new buy can never move an outcome that could already be known.
        {
            let sh = ctx.accounts.slot_hashes.try_borrow_data()?;
            reveal_matured(&mut ticket, &sh, payload.slot);
        }

        // 2. What this buy earned.
        let cfg = &mut ctx.accounts.cfg;
        let earned = (payload.amount_out / cfg.unit).min(cfg.max_per_buy as u64) as u32;
        let left = cfg
            .max_supply
            .saturating_sub(cfg.live)
            .saturating_sub(cfg.reserved_pending);
        let room = MAX_PIECES_PER_WALLET.saturating_sub(ticket.pieces() as usize) as u32;
        let pieces = earned.min(left).min(room).min(u8::MAX as u32);
        let art = cfg.art;

        // 3. Where it goes: the newest batch if its outcome is still unknowable and the
        //    rolls stay contiguous, else an empty slot, else nowhere.
        let target = payload.slot + REVEAL_DELAY_SLOTS;
        let mut placed = false;
        if pieces > 0 {
            if let Some(b) = ticket.batches.iter_mut().find(|b| {
                b.state == BATCH_WAITING
                    && b.target_slot > payload.slot
                    && b.art == art
                    && b.first_roll + b.pieces as u32 + b.minted_from as u32 == ticket.rolls
                    && b.pieces as u32 + pieces <= u8::MAX as u32
            }) {
                b.pieces += pieces as u8;
                placed = true;
            } else if let Some(b) = ticket.batches.iter_mut().find(|b| b.state == BATCH_EMPTY) {
                *b = Batch {
                    state: BATCH_WAITING,
                    pieces: pieces as u8,
                    minted_from: 0,
                    first_roll: ticket.rolls,
                    target_slot: target,
                    seed: [0u8; 32],
                    art,
                };
                placed = true;
            }
            if placed {
                ticket.rolls += pieces;
                cfg.reserved_pending += pieces;
                emit!(PiecesEarned { pool: cfg.pool, user: ticket.user, pieces, slot: payload.slot, target_slot: target });
            }
        }
        {
            let mut data = t_info.try_borrow_mut_data()?;
            let mut w: &mut [u8] = &mut data;
            ticket.try_serialize(&mut w)?;
        }
        Ok(())
    }
}

// ---- Metaplex Core, by hand (the crate targets older Solana releases) -------------

fn put_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

/// CreateCollectionV1 (discriminator 1): name, uri, and the three permanent plugins that
/// peg the pieces. Each is held by the collection's update authority, this program's PDA:
/// freeze (plugin 5, frozen), transfer (plugin 7), burn (plugin 8).
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn create_core_collection<'info>(
    collection: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    core_program: &AccountInfo<'info>,
    pool: &Pubkey,
    collection_bump: u8,
    name: &str,
    uri: &str,
) -> Result<()> {
    let mut data = vec![1u8];
    put_string(&mut data, name);
    put_string(&mut data, uri);
    data.push(1); // plugins: Some
    data.extend_from_slice(&3u32.to_le_bytes());
    // (plugin, Some(Authority::UpdateAuthority))
    data.extend_from_slice(&[5, 1, 1, 2]); // PermanentFreezeDelegate { frozen: true }
    data.extend_from_slice(&[7, 1, 2]); // PermanentTransferDelegate
    data.extend_from_slice(&[8, 1, 2]); // PermanentBurnDelegate
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(collection.key(), true),
            AccountMeta::new_readonly(authority.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        data,
    };
    let bump = [collection_bump];
    let seeds: &[&[u8]] = &[COLLECTION_SEED, pool.as_ref(), &bump];
    invoke_signed(
        &ix,
        &[collection.clone(), authority.clone(), payer.clone(), system_program.clone(), core_program.clone()],
        &[seeds],
    )?;
    Ok(())
}

/// CreateV1 (discriminator 0) into the collection: the piece belongs to `owner`, is paid
/// for by `payer` (the owner itself in `mint`, any sender in `mint_for`), and takes the
/// collection as its update authority.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn create_core_asset<'info>(
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    core_program: &AccountInfo<'info>,
    pool: &Pubkey,
    idx: &[u8; 4],
    asset_bump: u8,
    authority_bump: u8,
    name: &str,
    uri: &str,
) -> Result<()> {
    let mut data = vec![0u8, 0u8]; // CreateV1, DataState::AccountState
    put_string(&mut data, name);
    put_string(&mut data, uri);
    data.push(0); // plugins: None
    let user = owner.key();
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(asset.key(), true),
            AccountMeta::new(collection.key(), false),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new(payer.key(), true),            // payer
            AccountMeta::new_readonly(user, false),         // owner
            AccountMeta::new_readonly(MPL_CORE_ID, false),  // update authority: the collection
            AccountMeta::new_readonly(system_program.key(), false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),  // log wrapper: none
        ],
        data,
    };
    let ab = [asset_bump];
    let asset_seeds: &[&[u8]] = &[ASSET_SEED, pool.as_ref(), user.as_ref(), idx, &ab];
    let hb = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool.as_ref(), &hb];
    invoke_signed(
        &ix,
        &[
            asset.clone(),
            collection.clone(),
            authority.clone(),
            payer.clone(),
            owner.clone(),
            system_program.clone(),
            core_program.clone(),
        ],
        &[asset_seeds, authority_seeds],
    )?;
    Ok(())
}

/// BurnV1 (discriminator 12), signed by the collection authority as permanent burn
/// delegate. Core returns the asset's rent to `payer`.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn burn_core_asset<'info>(
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    core_program: &AccountInfo<'info>,
    pool: &Pubkey,
    authority_bump: u8,
) -> Result<()> {
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(asset.key(), false),
            AccountMeta::new(collection.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new_readonly(system_program.key(), false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper: none
        ],
        data: vec![12u8, 0u8], // BurnV1, no compression proof
    };
    let hb = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool.as_ref(), &hb];
    invoke_signed(
        &ix,
        &[asset.clone(), collection.clone(), payer.clone(), authority.clone(), system_program.clone(), core_program.clone()],
        &[authority_seeds],
    )?;
    Ok(())
}

/// TransferV1 (discriminator 14), signed by the collection authority as permanent
/// transfer delegate: the only way a frozen piece changes wallet.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn transfer_core_asset<'info>(
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    new_owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    core_program: &AccountInfo<'info>,
    pool: &Pubkey,
    authority_bump: u8,
) -> Result<()> {
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(asset.key(), false),
            AccountMeta::new_readonly(collection.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new_readonly(new_owner.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper: none
        ],
        data: vec![14u8, 0u8], // TransferV1, no compression proof
    };
    let hb = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool.as_ref(), &hb];
    invoke_signed(
        &ix,
        &[asset.clone(), collection.clone(), payer.clone(), authority.clone(), new_owner.clone(), system_program.clone(), core_program.clone()],
        &[authority_seeds],
    )?;
    Ok(())
}

/// SPL Token TransferChecked (instruction 12), signed by the sending wallet.
#[inline(never)]
fn transfer_coins<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let ix = Instruction {
        program_id: token_program.key(),
        accounts: vec![
            AccountMeta::new(from.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new(to.key(), false),
            AccountMeta::new_readonly(authority.key(), true),
        ],
        data,
    };
    invoke(&ix, &[from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()])?;
    Ok(())
}

/// Create a wallet's ticket account for it, paid by `payer`. Works even if someone sent
/// lamports to the address beforehand.
#[inline(never)]
fn create_ticket_account<'info>(
    ticket: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    pool: &Pubkey,
    wallet: &Pubkey,
    bump: u8,
    space: usize,
) -> Result<()> {
    use anchor_lang::system_program as sys;
    let rent = Rent::get()?.minimum_balance(space);
    let b = [bump];
    let seeds: &[&[u8]] = &[TICKET_SEED, pool.as_ref(), wallet.as_ref(), &b];
    if ticket.lamports() == 0 {
        sys::create_account(
            CpiContext::new_with_signer(sys::ID, sys::CreateAccount { from: payer.clone(), to: ticket.clone() }, &[seeds]),
            rent,
            space as u64,
            &crate::ID,
        )?;
        return Ok(());
    }
    let short = rent.saturating_sub(ticket.lamports());
    if short > 0 {
        sys::transfer(CpiContext::new(sys::ID, sys::Transfer { from: payer.clone(), to: ticket.clone() }), short)?;
    }
    sys::allocate(
        CpiContext::new_with_signer(sys::ID, sys::Allocate { account_to_allocate: ticket.clone() }, &[seeds]),
        space as u64,
    )?;
    sys::assign(
        CpiContext::new_with_signer(sys::ID, sys::Assign { account_to_assign: ticket.clone() }, &[seeds]),
        &crate::ID,
    )?;
    Ok(())
}

/// UpdateCollectionV1 (discriminator 16).
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn update_core_collection<'info>(
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    core_program: &AccountInfo<'info>,
    pool: &Pubkey,
    authority_bump: u8,
    new_name: Option<&str>,
    new_uri: Option<&str>,
) -> Result<()> {
    let mut data = vec![16u8];
    for v in [new_name, new_uri] {
        match v {
            Some(s) => {
                data.push(1);
                put_string(&mut data, s);
            }
            None => data.push(0),
        }
    }
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(collection.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // new update authority: none
            AccountMeta::new_readonly(system_program.key(), false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper: none
        ],
        data,
    };
    let hb = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool.as_ref(), &hb];
    invoke_signed(
        &ix,
        &[collection.clone(), payer.clone(), authority.clone(), system_program.clone(), core_program.clone()],
        &[authority_seeds],
    )?;
    Ok(())
}

// ---- accounts ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitManifest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: this program's ProgramData, parsed in the handler.
    pub program_data: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + HookManifest::INIT_SPACE, seeds = [MANIFEST_SEED], bump)]
    pub manifest: Account<'info, HookManifest>,
    /// CHECK: raw TLV account, written by the handler.
    #[account(init, payer = authority, space = extra_metas_size(3).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct InitPoolConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(init, payer = payer, space = 8 + CollectionConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// CHECK: the Metaplex Core collection, created here; a PDA of this program.
    #[account(mut, seeds = [COLLECTION_SEED, pool.as_ref()], bump)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA that is the collection's update authority. Holds no data.
    #[account(seeds = [AUTHORITY_SEED, pool.as_ref()], bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitPeg<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The coin. It signs, so only whoever creates the mint can bind it.
    pub mint: Signer<'info>,
    /// CHECK: the quote mint of the pool; only its address is used, to check the pool.
    pub quote_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// CHECK: raw TLV account, written by the handler. Token-2022 reads it at this address.
    #[account(init, payer = payer, space = ExtraAccountMetaList::size_of(4).unwrap(), seeds = [VALIDATION_SEED, mint.key().as_ref()], bump)]
    pub validation: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = Q_ENTRIES, seeds = [QUEUE_SEED, cfg.pool.as_ref()], bump)]
    pub queue: Account<'info, BurnQueue>,
    pub system_program: Program<'info, System>,
}

/// The transfer hook interface: source, mint, destination, authority, the account list,
/// then the accounts that list names. Token-2022 passes the first four read-only.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: the token account the coins left; checked in the handler.
    pub source: UncheckedAccount<'info>,
    /// CHECK: the coin; checked against the config.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the token account the coins reached; checked in the handler.
    pub destination: UncheckedAccount<'info>,
    /// CHECK: owner or delegate of the source. Not used.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this hook's account list. Not used: the transferring flag proves the caller.
    pub validation: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// CHECK: the sender's ticket; may not exist. Checked by its contents.
    #[account(mut)]
    pub from_ticket: UncheckedAccount<'info>,
    /// CHECK: the receiver's ticket; may not exist. Checked by its contents.
    #[account(mut)]
    pub to_ticket: UncheckedAccount<'info>,
    /// CHECK: the pool's burn queue. Checked by its contents.
    #[account(mut)]
    pub queue: UncheckedAccount<'info>,
}

/// Permissionless.
#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = collection)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    #[account(seeds = [TICKET_SEED, cfg.pool.as_ref(), ticket.user.as_ref()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the wallet this ticket belongs to: the new Metaplex owner.
    #[account(address = ticket.user)]
    pub holder: UncheckedAccount<'info>,
    /// CHECK: the Core collection recorded in the config.
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless.
#[derive(Accounts)]
pub struct Reap<'info> {
    /// Pays the fee and receives the rent of the assets it burns.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = collection)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// CHECK: the pool's burn queue, at its PDA. Worked on as raw bytes, like the transfer
    /// hook does, so nothing is written back over them when the instruction ends.
    #[account(mut, seeds = [QUEUE_SEED, cfg.pool.as_ref()], bump, owner = crate::ID @ CollectibleError::WrongQueue)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: the Core collection recorded in the config.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stage<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, cfg.pool.as_ref(), user.key().as_ref()],
        bump = ticket.bump,
        has_one = user @ CollectibleError::WrongTicket,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the wallet's token account for the coin; address and contents are checked
    /// in the handler.
    pub coins: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey, wallet: Pubkey)]
pub struct OpenTicketFor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the wallet's ticket, at its address. Created here unless it is already open.
    #[account(mut, seeds = [TICKET_SEED, pool.as_ref(), wallet.as_ref()], bump)]
    pub ticket: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct OpenTicket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: the wallet's ticket, at its address. Created here unless it is already open.
    #[account(mut, seeds = [TICKET_SEED, pool.as_ref(), user.key().as_ref()], bump)]
    pub ticket: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: any wallet may reveal any ticket.
#[derive(Accounts)]
pub struct Reveal<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TICKET_SEED, ticket.pool.as_ref(), ticket.user.as_ref()], bump = ticket.bump)]
    pub ticket: Account<'info, Ticket>,
    /// CHECK: the SlotHashes sysvar, parsed by hand (too large for Sysvar::get).
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MintPieces<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = collection)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// Grown in the handler to hold exactly the pieces minted, its own deposit first.
    #[account(
        mut,
        seeds = [TICKET_SEED, cfg.pool.as_ref(), user.key().as_ref()],
        bump = ticket.bump,
        has_one = user @ CollectibleError::WrongTicket,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the wallet's token account for the coin; address and contents are checked
    /// in the handler.
    pub coins: UncheckedAccount<'info>,
    /// CHECK: the Core collection recorded in the config.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the SlotHashes sysvar, parsed by hand.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// Permissionless: anyone may mint a wallet's decided pieces into that wallet, paid by the
/// wallet's deposit. The wallet does not sign and gives nothing but its deposit.
#[derive(Accounts)]
pub struct MintFor<'info> {
    /// Pays the Metaplex rent and is paid back from the deposit, with `KEEPER_FEE`.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the wallet whose pieces these are; it owns them once minted. Bound to the
    /// ticket by its address and `has_one`.
    pub user: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = collection)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// Grown in the handler, out of its own deposit.
    #[account(
        mut,
        seeds = [TICKET_SEED, cfg.pool.as_ref(), user.key().as_ref()],
        bump = ticket.bump,
        has_one = user @ CollectibleError::WrongTicket,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the wallet's token account for the coin; address and contents are checked
    /// in the handler.
    pub coins: UncheckedAccount<'info>,
    /// CHECK: the Core collection recorded in the config.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the SlotHashes sysvar, parsed by hand.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// The wallet alone.
#[derive(Accounts)]
pub struct WithdrawDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.pool.as_ref(), user.key().as_ref()],
        bump = ticket.bump,
        has_one = user @ CollectibleError::WrongTicket,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
}

/// Permissionless: any wallet may settle any ticket.
#[derive(Accounts)]
pub struct Settle<'info> {
    /// Pays the fee and receives the rent of the pieces it burns.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = collection)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    #[account(mut, seeds = [TICKET_SEED, cfg.pool.as_ref(), ticket.user.as_ref()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the ticket wallet's token account for the coin; address and contents are
    /// checked in the handler.
    pub coins: UncheckedAccount<'info>,
    /// CHECK: the Core collection recorded in the config.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reorder<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, cfg.pool.as_ref(), user.key().as_ref()],
        bump = ticket.bump,
        has_one = user @ CollectibleError::WrongTicket,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the wallet's token account for the coin; address and contents are checked
    /// in the handler.
    pub coins: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SendPieces<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = collection)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, cfg.pool.as_ref(), user.key().as_ref()],
        bump = ticket.bump,
        has_one = user @ CollectibleError::WrongTicket,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: the receiving wallet.
    pub to: UncheckedAccount<'info>,
    /// CHECK: the receiving wallet's ticket; created or grown in the handler.
    #[account(mut, seeds = [TICKET_SEED, cfg.pool.as_ref(), to.key().as_ref()], bump)]
    pub to_ticket: UncheckedAccount<'info>,
    /// CHECK: the coin.
    #[account(address = cfg.base_mint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the sender's token account for the coin; address checked in the handler.
    #[account(mut)]
    pub from_coins: UncheckedAccount<'info>,
    /// CHECK: the receiver's token account for the coin; address checked in the handler.
    #[account(mut)]
    pub to_coins: UncheckedAccount<'info>,
    /// CHECK: the coin's token program.
    #[account(address = cfg.token_program)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the Core collection recorded in the config.
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCollection<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        has_one = collection,
        constraint = cfg.owner != Pubkey::default() @ CollectibleError::Locked,
        constraint = cfg.owner == owner.key() @ CollectibleError::NotOwner,
    )]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// CHECK: the Core collection recorded in the config.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: PDA signer for the collection.
    #[account(seeds = [AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        constraint = cfg.owner != Pubkey::default() @ CollectibleError::Locked,
        constraint = cfg.owner == owner.key() @ CollectibleError::NotOwner,
    )]
    pub cfg: Box<Account<'info, CollectionConfig>>,
}

/// The five fixed callback accounts, then this hook's three extras.
#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: verified against the pool program's caller PDA in the handler.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, CollectionConfig>>,
    /// CHECK: the trader's ticket for this pool; may not exist, then the buy earns nothing.
    #[account(mut, seeds = [TICKET_SEED, pool.key().as_ref(), user.key().as_ref()], bump)]
    pub ticket: UncheckedAccount<'info>,
    /// CHECK: the SlotHashes sysvar, parsed by hand.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_raw_ticket_view_is_the_borsh_layout() {
        let k = |b: u8| Pubkey::new_from_array([b; 32]);
        let mut t = Ticket {
            bump: 7,
            pool: k(1),
            user: k(2),
            minted: 9,
            rolls: 14,
            staged: 2,
            staged_slot: 0x0102030405060708,
            batches: [Batch::default(); MAX_BATCHES],
            owned: vec![k(10), k(11), k(12)],
        };
        t.batches[1] = Batch { state: BATCH_WAITING, pieces: 3, minted_from: 1, first_roll: 5, target_slot: 99, seed: [0; 32], art: [6; 16] };
        t.batches[3] = Batch { state: BATCH_REVEALED, pieces: 2, minted_from: 0, first_roll: 9, target_slot: 120, seed: [4; 32], art: [7; 16] };
        let mut d = Vec::new();
        t.try_serialize(&mut d).unwrap();
        assert_eq!(d.len(), Ticket::space(3));
        assert_eq!(&d[T_POOL..T_POOL + 32], k(1).as_ref());
        assert_eq!(&d[T_USER..T_USER + 32], k(2).as_ref());
        assert_eq!((d[T_STAGED], u64::from_le_bytes(d[T_STAGED_SLOT..T_STAGED_SLOT + 8].try_into().unwrap())), (2, 0x0102030405060708));
        assert_eq!((raw_owned(&d), raw_pending(&d)), (3, 5));

        // the borsh path, for comparison
        let mut same = t.clone();
        let mut cfg = CollectionConfig {
            bump: 0, authority_bump: 0, collection_bump: 0, pool: k(1), creator: k(3), owner: k(3), collection: k(4),
            base_mint: k(5), token_program: k(6), pegged: true, unit: 1, max_supply: 100, minted: 0, live: 0,
            reserved_pending: 5, max_per_buy: 3, art_version: 1, art: [0; 16], name: String::new(), uri_base: String::new(),
        };
        // three pieces above the peg: the newest batch goes whole, then the last roll of the older one
        assert_eq!(cancel_unbacked(&mut same, &mut cfg, 5).0, 3);
        assert_eq!(raw_drop_pending(&mut d, 3), 3);
        assert_eq!(raw_pop(&mut d), Some(k(12).to_bytes()));
        d.extend_from_slice(&[0u8; 32]);
        raw_push(&mut d, &k(20).to_bytes());
        let back = Ticket::try_deserialize(&mut &d[..]).unwrap();
        assert_eq!(back.owned, vec![k(10), k(11), k(20)]);
        assert_eq!(back.batches, same.batches, "the raw path drops exactly what the borsh path drops");
        assert_eq!(back.batches[3], Batch::default(), "an emptied batch is freed");
        assert_eq!((back.batches[1].pieces, back.batches[1].first_roll, back.batches[1].minted_from), (2, 5, 1));
        assert_eq!((back.minted, back.rolls, back.bump), (9, 14, 7));
        // more than there is: drops what exists and says so
        assert_eq!(raw_drop_pending(&mut d, 10), 2);
        assert_eq!(raw_pending(&d), 0);
    }

    #[test]
    fn the_cost_floor_counts_each_asset_at_its_exact_size() {
        let r = Rent::default();
        let uri = format!("{}/p/{}/{}", "https://x.io", hex(&[0u8; 16]), hex(&[1u8; 16]));
        assert_eq!(uri.len(), "https://x.io".len() + 68, "what mint_for adds to the base address");
        // pieces #9 and #10: one more digit in the second name
        let mut want = r.minimum_balance(Ticket::space(3)) - r.minimum_balance(Ticket::space(1));
        for n in [9u32, 10] {
            want += r.minimum_balance(core_asset_len(&format!("Cards #{n}"), &uri));
        }
        assert_eq!(mint_cost_floor(&r, Ticket::space(1), Ticket::space(3), "Cards", uri.len(), 9, 2, KEEPER_FEE), Some(want + KEEPER_FEE));
        // a ticket that is already large enough adds no growth
        assert_eq!(
            mint_cost_floor(&r, Ticket::space(5), Ticket::space(5), "Cards", uri.len(), 9, 2, 0),
            Some(want - (r.minimum_balance(Ticket::space(3)) - r.minimum_balance(Ticket::space(1))))
        );
        assert_eq!(deposit_of(r.minimum_balance(100) + 7, 100, &r), 7);
        assert_eq!(deposit_of(r.minimum_balance(100) - 1, 100, &r), 0);
    }

    #[test]
    fn the_config_keeps_its_pool_at_byte_eleven() {
        // init_peg tells Token-2022 to read the pool from there to find a wallet's ticket
        let pool = Pubkey::new_from_array([9; 32]);
        let cfg = CollectionConfig {
            bump: 1, authority_bump: 2, collection_bump: 3, pool, creator: pool, owner: pool, collection: pool,
            base_mint: pool, token_program: pool, pegged: true, unit: 1, max_supply: 1, minted: 0, live: 0,
            reserved_pending: 0, max_per_buy: 1, art_version: 1, art: [0; 16], name: "a".into(), uri_base: "b".into(),
        };
        let mut d = Vec::new();
        cfg.try_serialize(&mut d).unwrap();
        assert_eq!(&d[11..43], pool.as_ref());
    }

    #[test]
    fn token_2022_extensions_are_found_by_type() {
        let mut d = vec![0u8; 166];
        d[165] = 2;
        d.extend_from_slice(&[7, 0, 0, 0]); // ImmutableOwner, empty
        d.extend_from_slice(&[15, 0, 1, 0, 1]); // TransferHookAccount, transferring
        assert_eq!(t22_extension(&d, EXT_TRANSFER_HOOK_ACCOUNT), Some(&[1u8][..]));
        assert_eq!(t22_extension(&d, EXT_TRANSFER_HOOK), None);
        assert_eq!(t22_extension(&d[..100], EXT_TRANSFER_HOOK_ACCOUNT), None);
    }

    #[test]
    fn a_multisig_is_never_read_as_a_token_account_or_a_mint() {
        // Review finding: a Token-2022 multisig is 355 free-form bytes. Its creator can make
        // them read as "a token account of this coin, owned by any wallet, mid-transfer".
        let mint = Pubkey::new_from_array([7; 32]);
        let victim = Pubkey::new_from_array([8; 32]);
        let forge = |len: usize, kind: u8, ext: &[u8]| {
            let mut d = vec![0u8; len];
            d[0..32].copy_from_slice(mint.as_ref());
            d[32..64].copy_from_slice(victim.as_ref());
            d[64..72].copy_from_slice(&5u64.to_le_bytes());
            d[165] = kind;
            d[166..166 + ext.len()].copy_from_slice(ext);
            d
        };
        let transferring = [15u8, 0, 1, 0, 1];
        // the same bytes at any other length are a token account in transfer: the check bites
        assert_eq!(transferring_account_bytes(&forge(356, 2, &transferring), &mint), Some((victim, 5)));
        assert_eq!(transferring_account_bytes(&forge(T22_MULTISIG_LEN, 2, &transferring), &mint), None);
        assert_eq!(transferring_account_bytes(&forge(356, 2, &[15, 0, 1, 0, 0]), &mint), None, "not in a transfer");
        assert_eq!(transferring_account_bytes(&forge(356, 1, &transferring), &mint), None, "a mint is not a token account");
        assert_eq!(transferring_account_bytes(&forge(356, 2, &transferring), &victim), None, "another coin");

        let mut hook = vec![14u8, 0, 64, 0];
        hook.extend_from_slice(&[0u8; 32]);
        hook.extend_from_slice(crate::ID.as_ref());
        assert!(pegged_mint_bytes(&forge(356, 1, &hook)));
        assert!(!pegged_mint_bytes(&forge(T22_MULTISIG_LEN, 1, &hook)));
        let mut with_authority = hook.clone();
        with_authority[4] = 1;
        assert!(!pegged_mint_bytes(&forge(356, 1, &with_authority)), "a hook someone can still change");
    }

    fn sysvar(entries: &[(u64, u8)]) -> Vec<u8> {
        let mut d = (entries.len() as u64).to_le_bytes().to_vec();
        for (slot, fill) in entries {
            d.extend_from_slice(&slot.to_le_bytes());
            d.extend_from_slice(&[*fill; 32]);
        }
        d
    }

    #[test]
    fn lookup_uses_the_first_block_at_or_after_the_target() {
        // newest first; slot 103 was skipped
        let d = sysvar(&[(105, 5), (104, 4), (102, 2), (101, 1)]);
        assert_eq!(lookup_slot_hash(&d, 102), SlotLookup::Found([2; 32]));
        assert_eq!(lookup_slot_hash(&d, 103), SlotLookup::Found([4; 32]), "skipped slot: next block");
        assert_eq!(lookup_slot_hash(&d, 105), SlotLookup::Found([5; 32]));
        assert_eq!(lookup_slot_hash(&d, 106), SlotLookup::NotYet);
        assert_eq!(lookup_slot_hash(&d, 100), SlotLookup::Expired, "older than the window: never a later block");
        assert_eq!(lookup_slot_hash(&sysvar(&[]), 5), SlotLookup::NotYet);
    }

    #[test]
    fn expired_batches_are_forced_common_and_seeds_ignore_everything_but_batch_and_roll() {
        let live = Batch { state: BATCH_REVEALED, pieces: 2, minted_from: 0, first_roll: 7, target_slot: 50, seed: [9; 32], art: [0; 16] };
        let dead = Batch { state: BATCH_EXPIRED, ..live };
        assert_eq!(piece_seed(&dead, 7)[9], 0xFF);
        assert_eq!(piece_seed(&live, 7), piece_seed(&live, 7), "deterministic");
        assert_ne!(piece_seed(&live, 7), piece_seed(&live, 8), "each roll its own piece");
        let other = Batch { seed: [8; 32], ..live };
        assert_ne!(piece_seed(&live, 7), piece_seed(&other, 7));
    }
}
