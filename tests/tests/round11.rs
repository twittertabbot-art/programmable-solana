//! Round 11: a ticket gives back the rent of pieces it no longer holds.
//!
//! Every piece a wallet mints grows its ticket by 32 bytes, paid out of the deposit (what a
//! ticket holds above the rent of its size). Before this round `settle` and the sender's
//! `send_pieces` shortened the list but never the account, so the rent of those bytes stayed in
//! the ticket for good. Now both shrink the ticket to exactly its list after their last CPI, and
//! `withdraw_deposit` shrinks it first. A shrink moves no lamport: the rent it frees is then
//! above the rent of the new size, which makes it the wallet's deposit, used first by its next
//! mint and paid out by the withdraw.
//!
//! The tests check the exact lamports at the local rent and at mainnet's (5,080 a byte), the
//! sender and the receiver of a send, a stranger's settle, a ticket shrunk and grown again
//! against the binary live on mainnet, the tickets the live binaries left longer than their
//! list, the pegged coin (whose transfer hook already shrank the sender, and which this round
//! does not change), and a random walk over every plain-coin instruction.
//!
//! The upgrade tests load the binaries that were live on mainnet:
//! `tests/fixtures/hook_collectible_live_r7.so` (round 7, 83939dca...835a: its `mint` grew a
//! ticket for `count` pieces even when it minted fewer) and
//! `tests/fixtures/hook_collectible_live_r8.so` (round 8, 5312fa58...e569, live since round 8).

use anchor_lang::prelude::Rent;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hook_collectible::{CollectionConfig, Ticket, KEEPER_FEE, QUEUE_SEED, Q_COUNT, Q_ENTRIES, SLOT_HASHES_ID, VALIDATION_SEED};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_account::Account;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_sha256_hasher::hashv;
use solana_signer::Signer;
use solana_slot_hashes::SlotHashes;

const BASE_LIQ: u64 = 1_000_000_000_000; // 1M coins at 6 decimals
const QUOTE_LIQ: u64 = 100 * SOL;
/// 2,000 coins per piece: a 1 SOL buy (about 9,870 coins) earns 4 before the cap.
const UNIT: u64 = 2_000 * 1_000_000;
const DECIMALS: u8 = 6;
const ART: [u8; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const NAME: &str = "Shots";
const URI_BASE: &str = "https://example.com/art";
/// Metaplex Core's create fee, kept in each asset (the Core binary the tests load).
const CORE_FEE: u64 = 1_500_000;
/// What the SDK (`depositAssetSize`, collectible.ts) sizes a piece's asset at while the
/// collection is not locked: 75 + 24 + 2 + 10 + 80 + 68.
const SDK_OPEN_ASSET_SIZE: usize = 75 + 24 + 2 + 10 + 80 + 68;
/// Mainnet's rent: lamports per byte of account (data and the 128 bytes of overhead).
const MAINNET_PER_BYTE: u64 = 5_080;
/// The local validator's and LiteSVM's.
const LOCAL_PER_BYTE: u64 = 6_960;
const LIVE_R7_SO: &str = "hook_collectible_live_r7.so";
const LIVE_R7_SHA256: &str = "83939dcadccee88df8310005c0e7f0e54ed620c0ccd8aa4fec34c750ff46835a";
const LIVE_R8_SO: &str = "hook_collectible_live_r8.so";
const LIVE_R8_SHA256: &str = "5312fa58c7e4fe976096d96ab4cdc2781fe11c8338c7ec48a342c285709de569";

// ---- addresses ----------------------------------------------------------------------------

fn pid() -> Pubkey {
    hook_collectible::ID
}
fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pid()).0
}
fn cfg_of(pool: &Pubkey) -> Pubkey {
    pda(&[hook_collectible::CFG_SEED, pool.as_ref()])
}
fn collection_of(pool: &Pubkey) -> Pubkey {
    pda(&[hook_collectible::COLLECTION_SEED, pool.as_ref()])
}
fn authority_of(pool: &Pubkey) -> Pubkey {
    pda(&[hook_collectible::AUTHORITY_SEED, pool.as_ref()])
}
fn ticket_of(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    pda(&[hook_collectible::TICKET_SEED, pool.as_ref(), user.as_ref()])
}
fn asset_of(pool: &Pubkey, user: &Pubkey, index: u32) -> Pubkey {
    pda(&[hook_collectible::ASSET_SEED, pool.as_ref(), user.as_ref(), &index.to_le_bytes()])
}
fn queue_of(pool: &Pubkey) -> Pubkey {
    pda(&[QUEUE_SEED, pool.as_ref()])
}
fn validation_of(mint: &Pubkey) -> Pubkey {
    pda(&[VALIDATION_SEED, mint.as_ref()])
}
/// The wallet's associated token account for the pool's coin, under the coin's own program.
fn coins_of(k: &PoolKeys, wallet: &Pubkey) -> Pubkey {
    ata_with(wallet, &k.base_mint, &k.base_program)
}
fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A plain coin's hook accounts for a trade by `user`.
fn hook_for(pool: &Pubkey, user: &Pubkey) -> HookRef {
    HookRef {
        program: pid(),
        treasury: system_program::ID,
        extra: vec![AccountMeta::new(cfg_of(pool), false), AccountMeta::new(ticket_of(pool, user), false), AccountMeta::new_readonly(SLOT_HASHES_ID, false)],
    }
}
/// A pegged coin's hook accounts for a trade by `user`: the callback's three, then what the
/// coin's transfer hook needs between `user` and the vault.
fn peg_hook_for(k: &PoolKeys, user: &Pubkey) -> HookRef {
    HookRef {
        program: pid(),
        treasury: system_program::ID,
        extra: vec![
            AccountMeta::new(cfg_of(&k.pool), false),
            AccountMeta::new(ticket_of(&k.pool, user), false),
            AccountMeta::new_readonly(SLOT_HASHES_ID, false),
            AccountMeta::new(ticket_of(&k.pool, &k.pool), false),
            AccountMeta::new(queue_of(&k.pool), false),
            AccountMeta::new_readonly(validation_of(&k.base_mint), false),
        ],
    }
}

// ---- the chain's clock --------------------------------------------------------------------

fn block_hash(slot: u64) -> [u8; 32] {
    hashv(&[b"block", &slot.to_le_bytes()]).to_bytes()
}
/// Move the chain to `slot`; SlotHashes holds every slot in `from..slot`.
fn go(env: &mut Env, slot: u64, from: u64) {
    env.svm.warp_to_slot(slot);
    let v: Vec<(u64, Hash)> = (from..slot).map(|s| (s, Hash::new_from_array(block_hash(s)))).collect();
    env.svm.set_sysvar(&SlotHashes::new(&v));
}

// ---- instructions ------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn init_config_ix(payer: &Pubkey, owner: &Pubkey, pool: &Pubkey, name: &str, uri: &str, max_supply: u32, max_per_buy: u8) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::InitPoolConfig {
            payer: *payer,
            owner: *owner,
            cfg: cfg_of(pool),
            collection: collection_of(pool),
            collection_authority: authority_of(pool),
            core_program: MPL_CORE,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPoolConfig {
            pool: *pool,
            args: hook_collectible::InitCollectionArgs { name: name.into(), uri_base: uri.into(), unit: UNIT, max_supply, max_per_buy, art: ART },
        }
        .data(),
    }
}
fn init_peg_ix(payer: &Pubkey, k: &PoolKeys) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::InitPeg {
            payer: *payer,
            mint: k.base_mint,
            quote_mint: k.quote_mint,
            cfg: cfg_of(&k.pool),
            validation: validation_of(&k.base_mint),
            queue: queue_of(&k.pool),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPeg {}.data(),
    }
}
fn open_ticket_ix(user: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OpenTicket { user: *user, ticket: ticket_of(pool, user), system_program: system_program::ID }.to_account_metas(None),
        data: hook_collectible::instruction::OpenTicket { pool: *pool }.data(),
    }
}
fn mint_ix(user: &Pubkey, k: &PoolKeys, count: u8, first_index: u32, n: u32) -> Instruction {
    let mut accounts = hook_collectible::accounts::MintPieces {
        user: *user,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        coins: coins_of(k, user),
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
        slot_hashes: SLOT_HASHES_ID,
    }
    .to_account_metas(None);
    accounts.extend((0..n).map(|i| AccountMeta::new(asset_of(&k.pool, user, first_index + i), false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Mint { count }.data() }
}
fn mint_for_ix(payer: &Pubkey, k: &PoolKeys, user: &Pubkey, first_index: u32, n: u32) -> Instruction {
    let mut accounts = hook_collectible::accounts::MintFor {
        payer: *payer,
        user: *user,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        coins: coins_of(k, user),
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
        slot_hashes: SLOT_HASHES_ID,
    }
    .to_account_metas(None);
    accounts.extend((0..n).map(|i| AccountMeta::new(asset_of(&k.pool, user, first_index + i), false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::MintFor {}.data() }
}
fn withdraw_ix(user: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::WithdrawDeposit { user: *user, ticket: ticket_of(pool, user) }.to_account_metas(None),
        data: hook_collectible::instruction::WithdrawDeposit {}.data(),
    }
}
fn settle_ix(payer: &Pubkey, k: &PoolKeys, user: &Pubkey, assets: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::Settle {
        payer: *payer,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        coins: coins_of(k, user),
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(assets.iter().map(|a| AccountMeta::new(*a, false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Settle {}.data() }
}
/// A plain coin's `send_pieces`.
fn send_ix(user: &Pubkey, k: &PoolKeys, to: &Pubkey, assets: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::SendPieces {
        user: *user,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        to: *to,
        to_ticket: ticket_of(&k.pool, to),
        mint: k.base_mint,
        from_coins: coins_of(k, user),
        to_coins: coins_of(k, to),
        token_program: TOKEN,
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(assets.iter().map(|a| AccountMeta::new(*a, false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::SendPieces {}.data() }
}
fn stage_ix(user: &Pubkey, k: &PoolKeys, pieces: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::Stage { user: *user, cfg: cfg_of(&k.pool), ticket: ticket_of(&k.pool, user), coins: coins_of(k, user) }.to_account_metas(None);
    accounts.extend(pieces.iter().map(|a| AccountMeta::new_readonly(*a, false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Stage { count: pieces.len() as u8 }.data() }
}
fn deliver_ix(payer: &Pubkey, k: &PoolKeys, holder: &Pubkey, assets: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::Deliver {
        payer: *payer,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, holder),
        holder: *holder,
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(assets.iter().map(|a| AccountMeta::new(*a, false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Deliver {}.data() }
}
fn reap_ix(payer: &Pubkey, k: &PoolKeys, assets: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::Reap {
        payer: *payer,
        cfg: cfg_of(&k.pool),
        queue: queue_of(&k.pool),
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(assets.iter().map(|a| AccountMeta::new(*a, false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Reap {}.data() }
}
/// The deposit: a plain SOL transfer from the wallet to its own ticket.
fn deposit_ix(user: &Pubkey, pool: &Pubkey, lamports: u64) -> Instruction {
    system_instruction::transfer(user, &ticket_of(pool, user), lamports)
}
/// A pegged coin's plain wallet-to-wallet transfer, with the hook's accounts.
fn peg_transfer_ix(k: &PoolKeys, from: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
    let mut ix = t22::instruction::transfer_checked(&TOKEN_2022, &coins_of(k, from), &k.base_mint, &coins_of(k, to), from, &[], amount, DECIMALS).unwrap();
    ix.accounts.extend([
        AccountMeta::new(cfg_of(&k.pool), false),
        AccountMeta::new(ticket_of(&k.pool, from), false),
        AccountMeta::new(ticket_of(&k.pool, to), false),
        AccountMeta::new(queue_of(&k.pool), false),
        AccountMeta::new_readonly(validation_of(&k.base_mint), false),
        AccountMeta::new_readonly(pid(), false),
    ]);
    ix
}
/// A plain coin's plain token transfer: the coins leave, the pieces stay on the list unbacked.
fn coin_transfer_ix(k: &PoolKeys, from: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
    anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &coins_of(k, from), &coins_of(k, to), from, &[], amount).unwrap()
}

// ---- reading the chain --------------------------------------------------------------------

fn ticket(env: &Env, pool: &Pubkey, user: &Pubkey) -> Ticket {
    env.account(&ticket_of(pool, user))
}
fn cfg(env: &Env, pool: &Pubkey) -> CollectionConfig {
    env.account(&cfg_of(pool))
}
fn rent(env: &Env, len: usize) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(len)
}
/// The wallet's deposit: what its ticket holds above the rent of its size.
fn deposit(env: &Env, pool: &Pubkey, user: &Pubkey) -> u64 {
    let a = env.svm.get_account(&ticket_of(pool, user)).expect("a ticket");
    a.lamports - rent(env, a.data.len())
}
fn ticket_len(env: &Env, pool: &Pubkey, user: &Pubkey) -> usize {
    env.svm.get_account(&ticket_of(pool, user)).map(|a| a.data.len()).unwrap_or(0)
}
fn coins(env: &Env, k: &PoolKeys, wallet: &Pubkey) -> u64 {
    env.balance(&coins_of(k, wallet))
}
fn exists(env: &Env, key: &Pubkey) -> bool {
    env.svm.get_account(key).map(|a| !a.data.is_empty()).unwrap_or(false)
}
fn core_owner(env: &Env, asset: &Pubkey) -> Pubkey {
    Pubkey::new_from_array(env.svm.get_account(asset).unwrap().data[1..33].try_into().unwrap())
}
fn burned(env: &Env, asset: &Pubkey) -> bool {
    env.svm.get_account(asset).map(|a| a.data.len() == 1 && a.data[0] == 0).unwrap_or(false)
}
fn queue(env: &Env, k: &PoolKeys) -> Vec<Pubkey> {
    let d = env.svm.get_account(&queue_of(&k.pool)).unwrap().data;
    let n = u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
    (0..n).map(|i| Pubkey::new_from_array(d[Q_ENTRIES + 32 * i..Q_ENTRIES + 32 * (i + 1)].try_into().unwrap())).collect()
}
/// The lamports of a list of accounts, together.
fn lamports_of(env: &Env, keys: &[Pubkey]) -> u64 {
    keys.iter().map(|a| env.lamports(a)).sum()
}
/// (address, lamports, data) of each account, for comparing two chains.
fn snapshot(env: &Env, keys: &[Pubkey]) -> Vec<(Pubkey, u64, Vec<u8>)> {
    keys.iter().map(|a| env.svm.get_account(a).map(|x| (*a, x.lamports, x.data)).unwrap_or((*a, 0, vec![]))).collect()
}
/// What one signature costs on this chain.
fn signature_fee(env: &mut Env) -> u64 {
    let k = env.user(SOL);
    let before = env.lamports(&k.pubkey());
    env.ok(&[compute_budget_ix(10_000)], &[&k]);
    before - env.lamports(&k.pubkey())
}
/// Exactly what a `mint_for` of `n` pieces costs the wallet's deposit now: the ticket's
/// growth, each asset's rent at its exact number and Core's fee, one keeper fee.
fn mint_for_cost(env: &Env, pool: &Pubkey, user: &Pubkey, n: u32) -> u64 {
    let c = cfg(env, pool);
    let t = ticket(env, pool, user);
    let len = ticket_len(env, pool, user);
    let after = Ticket::space(t.owned.len() + n as usize).max(len);
    let uri = format!("{}/p/{}/{}", c.uri_base, "0".repeat(32), "0".repeat(32));
    let mut total = rent(env, after) - rent(env, len) + KEEPER_FEE;
    for i in 1..=n {
        total += rent(env, hook_collectible::core_asset_len(&format!("{} #{}", c.name, c.minted + i), &uri)) + CORE_FEE;
    }
    total
}
/// `mintDepositFor` of sdk/src/collectible.ts: per piece the asset's rent at
/// `depositAssetSize`, Core's fee, 32 bytes of ticket, one keeper fee.
fn sdk_deposit_for(env: &Env, c: &CollectionConfig, pieces: u32) -> u64 {
    let locked = c.owner == Pubkey::default();
    let asset = if locked { 75 + c.name.len() + 2 + 10 + c.uri_base.len() + 68 } else { SDK_OPEN_ASSET_SIZE };
    (rent(env, asset) + CORE_FEE + (rent(env, 32) - rent(env, 0)) + KEEPER_FEE) * pieces as u64
}
/// Fails, and the logs or the error name one of `needles`. Returns the one found.
fn refused(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair], needles: &[&str]) -> String {
    match env.send(ixs, signers) {
        Ok(m) => panic!("expected a refusal ({needles:?}), but it landed\n{}", m.pretty_logs()),
        Err(e) => {
            let hay = format!("{:?}\n{}", e.err, e.meta.logs.join("\n"));
            let hit = needles.iter().find(|n| hay.contains(**n)).unwrap_or_else(|| panic!("expected one of {needles:?} in:\n{hay}"));
            hit.to_string()
        }
    }
}
/// Simulate first, send only what the simulation accepts: what a keeper does. Ok(compute units).
fn keeper_send(env: &mut Env, keeper: &Keypair, ixs: &[Instruction]) -> Result<u64, String> {
    use solana_message::{Message, VersionedMessage};
    use solana_transaction::versioned::VersionedTransaction;
    let msg = Message::new_with_blockhash(ixs, Some(&keeper.pubkey()), &env.svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[keeper]).unwrap();
    if let Err(e) = env.svm.simulate_transaction(tx) {
        return Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    }
    Ok(env.ok(ixs, &[keeper]).compute_units_consumed)
}
fn cb(units: u32) -> Instruction {
    compute_budget_ix(units)
}

/// The books every instruction must keep: each ticket at least its rent and at least as long
/// as its list, the config's counters equal to what the tickets hold, and (`delivered`) every
/// listed piece in its holder's hands.
fn check_books(env: &Env, k: &PoolKeys, wallets: &[Pubkey], delivered: bool, what: &str) {
    let c = cfg(env, &k.pool);
    let (mut live, mut pending) = (0u32, 0u32);
    for w in wallets {
        if !exists(env, &ticket_of(&k.pool, w)) {
            continue;
        }
        let raw = env.svm.get_account(&ticket_of(&k.pool, w)).unwrap();
        let t = ticket(env, &k.pool, w);
        assert!(raw.data.len() >= Ticket::space(t.owned.len()), "{what}: a ticket shorter than its list");
        assert!(raw.lamports >= rent(env, raw.data.len()), "{what}: a ticket below its rent");
        live += t.owned.len() as u32;
        pending += t.pending();
        if delivered {
            for a in &t.owned {
                assert_eq!(core_owner(env, a), *w, "{what}: a listed piece is not in its holder's hands");
            }
        }
    }
    assert_eq!((c.live, c.reserved_pending), (live, pending), "{what}: the config's counters");
}

// ---- a plain coin -------------------------------------------------------------------------

/// Market, config and pool at slot 50.
fn plain_setup(env: &mut Env, max_per_buy: u8) -> (Market, PoolKeys) {
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    go(env, 50, 40);
    env.ok(&[cb(300_000), init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, NAME, URI_BASE, 1_000, max_per_buy)], &[&m.creator]);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook_for(&k.pool, &m.creator.pubkey()));
    env.ok(&[cb(400_000), ix], &[&m.creator]);
    (m, k)
}
fn newcomer(env: &mut Env, m: &Market) -> Keypair {
    let w = env.user(5 * SOL);
    env.fund(&w, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    w
}
fn buy_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &hook_for(&k.pool, user), DIRECTION_BUY, amount, 0)
}
fn sell_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &hook_for(&k.pool, user), DIRECTION_SELL, amount, 0)
}
fn sell_all_ix(env: &Env, user: &Pubkey, k: &PoolKeys) -> Instruction {
    sell_ix(env, user, k, coins(env, k, user))
}
/// The buy the site sends for ONE approval: open the ticket when new, swap, deposit.
fn buy_with_deposit(env: &mut Env, user: &Keypair, k: &PoolKeys, amount: u64, lamports: u64) {
    let mut ixs = vec![cb(400_000)];
    if !exists(env, &ticket_of(&k.pool, &user.pubkey())) {
        ixs.push(open_ticket_ix(&user.pubkey(), &k.pool));
    }
    ixs.push(buy_ix(env, &user.pubkey(), k, amount));
    if lamports > 0 {
        ixs.push(deposit_ix(&user.pubkey(), &k.pool, lamports));
    }
    env.ok(&ixs, &[user]);
}
/// The wallet's pieces, the end of its list first: what a settle names.
fn newest_first(env: &Env, k: &PoolKeys, user: &Pubkey) -> Vec<Pubkey> {
    ticket(env, &k.pool, user).owned.iter().rev().cloned().collect()
}

// ---- a pegged coin ------------------------------------------------------------------------

struct Peg {
    k: PoolKeys,
    authority: Keypair,
}
/// A Token-2022 coin whose transfer hook is the collectible program, bound to its config,
/// with its pool, at slot 50.
fn peg_setup(env: &mut Env, max_per_buy: u8) -> Peg {
    let authority = env.user(10 * SOL);
    let creator = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&creator, &creator.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 10_000 * SOL);
    go(env, 50, 30);
    let mint = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[t22::extension::ExtensionType::TransferHook]).unwrap();
    let ixs = [
        system_instruction::create_account(&creator.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::extension::transfer_hook::instruction::initialize(&TOKEN_2022, &mint.pubkey(), None, Some(pid())).unwrap(),
        t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &creator.pubkey(), None, DECIMALS).unwrap(),
    ];
    env.ok(&ixs, &[&creator, &mint]);
    let creator_coins = ata_with(&creator.pubkey(), &mint.pubkey(), &TOKEN_2022);
    let ixs = [
        Env::create_ata_with_ix(&creator.pubkey(), &creator.pubkey(), &mint.pubkey(), &TOKEN_2022),
        t22::instruction::mint_to(&TOKEN_2022, &mint.pubkey(), &creator_coins, &creator.pubkey(), &[], 10 * BASE_LIQ).unwrap(),
    ];
    env.ok(&ixs, &[&creator]);
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    let ixs = [cb(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, "Pegs", URI_BASE, 1_000, max_per_buy), init_peg_ix(&creator.pubkey(), &k)];
    env.ok(&ixs, &[&creator, &mint]);
    let ix = env.create_pool_ix(&creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &peg_hook_for(&k, &creator.pubkey()));
    env.ok(&[cb(500_000), ix], &[&creator]);
    Peg { k, authority }
}
fn peg_wallet(env: &mut Env, p: &Peg) -> Keypair {
    let w = env.user(5 * SOL);
    let q = env.create_ata(&w, &w.pubkey(), &p.k.quote_mint);
    env.mint_to(&p.authority, &p.k.quote_mint, &q, 50 * SOL);
    env.ok(&[Env::create_ata_with_ix(&w.pubkey(), &w.pubkey(), &p.k.base_mint, &TOKEN_2022)], &[&w]);
    env.ok(&[open_ticket_ix(&w.pubkey(), &p.k.pool)], &[&w]);
    w
}
fn peg_buy_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &peg_hook_for(k, user), DIRECTION_BUY, amount, 0)
}
fn peg_sell_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &peg_hook_for(k, user), DIRECTION_SELL, amount, 0)
}

// ---- the binaries -------------------------------------------------------------------------

fn live_binary(name: &str, sha256: &str) -> Vec<u8> {
    let p = fixture(name);
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}. The upgrade tests need the binaries that were live on mainnet.", p.display()));
    assert_eq!(hexs(&hashv(&[&bytes]).to_bytes()), sha256, "the fixture {name} is the binary that was live");
    bytes
}
/// Put `bytes` in place of hook_collectible, as an upgrade does, at the chain's current slot.
fn load(env: &mut Env, bytes: &[u8]) {
    env.svm.add_program(pid(), bytes).unwrap();
    let admin = env.admin.pubkey();
    env.patch_upgrade_authority(&pid(), Some(admin));
}

// =========================================================================================
// A plain coin: the sell's settle shrinks the ticket, the withdraw returns the growth
// =========================================================================================

/// Buy three pieces with a deposit, the keeper mints them, sell everything, settle, withdraw.
/// Checks every lamport at the chain's current rent. Returns (growth, what the withdraw paid).
fn three_pieces_bought_minted_sold_and_withdrawn(env: &mut Env) -> (u64, u64) {
    let (m, k) = plain_setup(env, 3);
    let fee = signature_fee(env);
    let w = newcomer(env, &m);
    let keeper = env.user(SOL);
    go(env, 100, 90);
    let dep = sdk_deposit_for(env, &cfg(env, &k.pool), 3);
    buy_with_deposit(env, &w, &k, SOL, dep);
    go(env, 103, 90);
    let k0 = env.lamports(&keeper.pubkey());
    let (held0, cost) = (deposit(env, &k.pool, &w.pubkey()), mint_for_cost(env, &k.pool, &w.pubkey(), 3));
    keeper_send(env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]).unwrap();
    assert_eq!(env.lamports(&keeper.pubkey()), k0 + KEEPER_FEE - fee, "the keeper is paid back exactly, plus its fee");
    assert_eq!((ticket(env, &k.pool, &w.pubkey()).owned.len(), ticket_len(env, &k.pool, &w.pubkey())), (3, Ticket::space(3)));
    let after_mint = deposit(env, &k.pool, &w.pubkey());
    assert_eq!(held0 - after_mint, cost, "the mint took exactly its cost, the ticket's growth included");
    let held = env.lamports(&ticket_of(&k.pool, &w.pubkey()));
    let growth = rent(env, Ticket::space(3)) - rent(env, Ticket::space(0));
    let per_byte = rent(env, 1) - rent(env, 0);
    assert_eq!(growth, 3 * 32 * per_byte, "three entries of 32 bytes");

    // the wallet sells everything, then settles itself: the assets' lamports come back to it,
    // the ticket shrinks to an empty list, and the rent of the 96 bytes stays in the ticket
    env.ok(&[cb(600_000), sell_all_ix(env, &w.pubkey(), &k)], &[&w]);
    let pieces = newest_first(env, &k, &w.pubkey());
    let in_assets = lamports_of(env, &pieces);
    let w0 = env.lamports(&w.pubkey());
    let cu = env.ok(&[cb(400_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &pieces)], &[&w]).compute_units_consumed;
    println!("settle that burns three pieces and shrinks the ticket: {cu} CU");
    assert!(pieces.iter().all(|p| burned(env, p)));
    assert_eq!(env.lamports(&w.pubkey()) + fee - w0, in_assets - lamports_of(env, &pieces), "the settle paid its sender what the assets gave up, nothing else");
    assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), held, "no lamport left the ticket");
    assert_eq!(ticket_len(env, &k.pool, &w.pubkey()), Ticket::space(0), "the ticket shrank to its empty list");
    assert_eq!(deposit(env, &k.pool, &w.pubkey()), after_mint + growth, "the freed rent is the wallet's deposit");

    // the withdraw pays all of it; the ticket keeps exactly the rent of an empty list
    let before = env.lamports(&w.pubkey());
    let cu = env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]).compute_units_consumed;
    println!("withdraw_deposit: {cu} CU");
    let paid = env.lamports(&w.pubkey()) + fee - before;
    assert_eq!(paid, after_mint + growth);
    assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), rent(env, Ticket::space(0)));
    refused(env, &[withdraw_ix(&w.pubkey(), &k.pool)], &[&w], &["NoDeposit"]);
    check_books(env, &k, &[w.pubkey()], true, "after the withdraw");
    (growth, paid)
}

#[test]
fn r11_plain_sell_all_the_settle_shrinks_the_ticket_and_withdraw_returns_the_growth() {
    let mut env = Env::new();
    assert_eq!(rent(&env, 1) - rent(&env, 0), LOCAL_PER_BYTE);
    let (growth, paid) = three_pieces_bought_minted_sold_and_withdrawn(&mut env);
    println!("local rent: three pieces sold, the withdraw paid {paid} lamports, {growth} of them the ticket's growth");
    assert_eq!(growth, 668_160, "3 x 32 bytes x 6,960");
}

#[test]
fn r11_plain_at_mainnet_rent_the_growth_comes_back_at_5080_lamports_a_byte() {
    let mut env = Env::new();
    env.svm.set_sysvar(&Rent::with_lamports_per_byte(MAINNET_PER_BYTE));
    assert_eq!((rent(&env, 0), rent(&env, 1) - rent(&env, 0)), (128 * MAINNET_PER_BYTE, MAINNET_PER_BYTE), "the chain runs at mainnet's rent");
    assert_eq!(rent(&env, Ticket::space(0)), 2_407_920, "an empty ticket on mainnet");
    let (growth, paid) = three_pieces_bought_minted_sold_and_withdrawn(&mut env);
    println!("mainnet rent: three pieces sold, the withdraw paid {paid} lamports, {growth} of them the ticket's growth");
    assert_eq!(growth, 3 * 162_560, "3 x 32 bytes x 5,080: 162,560 a piece");
}

// =========================================================================================
// send_pieces: the sender shrinks, the receiver grows from the sender as before
// =========================================================================================

#[test]
fn r11_send_pieces_shrinks_the_sender_and_the_receiver_grows_from_the_sender_as_before() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let a = newcomer(&mut env, &m);
    let b = newcomer(&mut env, &m);
    let c = newcomer(&mut env, &m);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &a, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 3, 0, 3)], &[&a]);
    // a and b hold deposits; c has no ticket at all
    env.ok(&[deposit_ix(&a.pubkey(), &k.pool, 777_777)], &[&a]);
    env.ok(&[open_ticket_ix(&b.pubkey(), &k.pool), deposit_ix(&b.pubkey(), &k.pool, 555_555)], &[&b]);
    let owned = ticket(&env, &k.pool, &a.pubkey()).owned.clone();

    // a sends two pieces to b: a's ticket loses two entries and keeps their rent, as a's
    // deposit; b's ticket grows by two entries, paid by a's wallet; b's deposit stays
    let (at0, bt0, a0) = (env.lamports(&ticket_of(&k.pool, &a.pubkey())), env.lamports(&ticket_of(&k.pool, &b.pubkey())), env.lamports(&a.pubkey()));
    env.ok(&[cb(400_000), send_ix(&a.pubkey(), &k, &b.pubkey(), &[owned[1], owned[2]])], &[&a]);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), ticket(&env, &k.pool, &a.pubkey()).owned.clone()), (Ticket::space(1), vec![owned[0]]));
    assert_eq!(env.lamports(&ticket_of(&k.pool, &a.pubkey())), at0, "no lamport left the sender's ticket");
    assert_eq!(deposit(&env, &k.pool, &a.pubkey()), 777_777 + 2 * entry);
    assert_eq!(ticket_len(&env, &k.pool, &b.pubkey()), Ticket::space(2));
    assert_eq!(env.lamports(&ticket_of(&k.pool, &b.pubkey())) - bt0, 2 * entry, "the receiver's growth, exactly");
    assert_eq!(deposit(&env, &k.pool, &b.pubkey()), 555_555, "the receiver's deposit did not pay for its growth");
    assert_eq!(a0 - env.lamports(&a.pubkey()), 2 * entry + fee, "the sender's wallet paid the receiver's growth, as before");
    assert!([owned[1], owned[2]].iter().all(|p| core_owner(&env, p) == b.pubkey()));

    // a sends its last piece to c, who has no ticket: the send opens it at a's cost, exactly
    // as long as its list; a's ticket shrinks to an empty list
    let a0 = env.lamports(&a.pubkey());
    env.ok(&[cb(400_000), send_ix(&a.pubkey(), &k, &c.pubkey(), &[owned[0]])], &[&a]);
    assert_eq!(a0 - env.lamports(&a.pubkey()), rent(&env, Ticket::space(1)) + fee);
    assert_eq!((ticket_len(&env, &k.pool, &c.pubkey()), deposit(&env, &k.pool, &c.pubkey())), (Ticket::space(1), 0));
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &a.pubkey())), (Ticket::space(0), 777_777 + 3 * entry));

    // b sends one back to a: b shrinks, a's empty ticket grows again from b's wallet; a's deposit stays
    let b0 = env.lamports(&b.pubkey());
    env.ok(&[cb(400_000), send_ix(&b.pubkey(), &k, &a.pubkey(), &[owned[2]])], &[&b]);
    assert_eq!(b0 - env.lamports(&b.pubkey()), entry + fee);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &a.pubkey())), (Ticket::space(1), 777_777 + 3 * entry));
    assert_eq!((ticket_len(&env, &k.pool, &b.pubkey()), deposit(&env, &k.pool, &b.pubkey())), (Ticket::space(1), 555_555 + entry));

    // each takes its own back, and the tickets stay exactly at their rent
    for (w, amount, list) in [(&a, 777_777 + 3 * entry, 1usize), (&b, 555_555 + entry, 1)] {
        let before = env.lamports(&w.pubkey());
        env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
        assert_eq!(env.lamports(&w.pubkey()), before + amount - fee);
        assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), rent(&env, Ticket::space(list)));
    }
    refused(&mut env, &[withdraw_ix(&c.pubkey(), &k.pool)], &[&c], &["NoDeposit"]);
    check_books(&env, &k, &[a.pubkey(), b.pubkey(), c.pubkey()], true, "sends");
}

// =========================================================================================
// A stranger's settle: the wallet's ticket shrinks, the stranger gets nothing from it
// =========================================================================================

#[test]
fn r11_a_strangers_settle_shrinks_the_wallets_ticket_and_pays_the_stranger_nothing_from_it() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let friend = newcomer(&mut env, &m);
    let stranger = env.user(SOL);
    let keeper = env.user(SOL);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    go(&mut env, 100, 90);
    let dep = sdk_deposit_for(&env, &cfg(&env, &k.pool), 3);
    buy_with_deposit(&mut env, &w, &k, SOL, dep);
    go(&mut env, 103, 90);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]).unwrap();
    // the coins leave by a plain transfer, one unit stays: two pieces are above the peg
    let all = coins(&env, &k, &w.pubkey());
    env.ok(&[coin_transfer_ix(&k, &w.pubkey(), &friend.pubkey(), all - UNIT)], &[&w]);
    let held = deposit(&env, &k.pool, &w.pubkey());
    let t_lamports = env.lamports(&ticket_of(&k.pool, &w.pubkey()));

    // the stranger settles the wallet: it receives what the two assets give up, and not a
    // lamport of the ticket, whose freed rent is the wallet's deposit
    let burn = newest_first(&env, &k, &w.pubkey());
    let in_assets = lamports_of(&env, &burn);
    let s0 = env.lamports(&stranger.pubkey());
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &burn)], &[&stranger]);
    assert!(burned(&env, &burn[0]) && burned(&env, &burn[1]) && !burned(&env, &burn[2]), "the end of the list burned, the backed piece stays");
    assert_eq!(env.lamports(&stranger.pubkey()) + fee - s0, in_assets - lamports_of(&env, &burn), "the stranger got the assets' lamports only");
    assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), t_lamports, "the ticket's lamports stayed");
    assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), deposit(&env, &k.pool, &w.pubkey())), (Ticket::space(1), held + 2 * entry));

    // nobody but the wallet reaches it: the stranger's withdraw from the wallet's ticket, a
    // mint for the wallet with nothing decided, a second settle with nothing to burn
    let mut ix = withdraw_ix(&stranger.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &w.pubkey());
    refused(&mut env, &[ix], &[&stranger], &["ConstraintSeeds"]);
    refused(&mut env, &[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 3, 1)], &[&stranger], &["NothingToMint"]);
    let s0 = env.lamports(&stranger.pubkey());
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &burn)], &[&stranger]);
    assert_eq!(s0 - env.lamports(&stranger.pubkey()), fee, "a settle with nothing to do pays nothing");
    assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), deposit(&env, &k.pool, &w.pubkey())), (Ticket::space(1), held + 2 * entry));

    // the wallet takes it
    let before = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()), before + held + 2 * entry - fee);
    assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), rent(&env, Ticket::space(1)));
    check_books(&env, &k, &[w.pubkey(), friend.pubkey()], true, "a stranger's settle");
}

// =========================================================================================
// Shrunk, then grown again: exactly where the live binary ends
// =========================================================================================

/// The second round of two wallets that held three pieces each and sold them: settle, buy
/// three again, mint (w by the keeper, v by itself), withdraw. Returns every account it
/// touched, and w's deposit before and after the keeper's mint with what that mint costs.
#[allow(clippy::type_complexity)]
fn second_round(env: &mut Env, k: &PoolKeys, w: &Keypair, v: &Keypair, keeper: &Keypair, w_pieces: &[Pubkey], v_pieces: &[Pubkey]) -> (Vec<(Pubkey, u64, Vec<u8>)>, [u64; 3]) {
    go(env, 110, 90);
    env.ok(&[cb(400_000), settle_ix(&w.pubkey(), k, &w.pubkey(), w_pieces)], &[w]);
    env.ok(&[cb(400_000), settle_ix(&keeper.pubkey(), k, &v.pubkey(), v_pieces)], &[keeper]);
    go(env, 120, 110);
    buy_with_deposit(env, w, k, SOL, SOL / 20);
    buy_with_deposit(env, v, k, SOL, 0);
    go(env, 123, 110);
    let (held, cost) = (deposit(env, &k.pool, &w.pubkey()), mint_for_cost(env, &k.pool, &w.pubkey(), 3));
    keeper_send(env, keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), k, &w.pubkey(), 3, 3)]).unwrap();
    let left = deposit(env, &k.pool, &w.pubkey());
    assert_eq!(held - left, cost, "the keeper's mint took exactly its cost from the deposit");
    env.ok(&[cb(400_000), mint_ix(&v.pubkey(), k, 3, 3, 3)], &[v]);
    let ws = snapshot(env, &[ticket_of(&k.pool, &w.pubkey()), ticket_of(&k.pool, &v.pubkey())]);
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
    let mut keys = vec![ticket_of(&k.pool, &w.pubkey()), ticket_of(&k.pool, &v.pubkey()), w.pubkey(), v.pubkey(), keeper.pubkey(), cfg_of(&k.pool), collection_of(&k.pool)];
    keys.extend((0..6).map(|i| asset_of(&k.pool, &w.pubkey(), i)));
    keys.extend((0..6).map(|i| asset_of(&k.pool, &v.pubkey(), i)));
    let mut all = ws;
    all.extend(snapshot(env, &keys));
    (all, [held, left, cost])
}

#[test]
fn r11_a_shrunk_ticket_minted_again_ends_exactly_where_the_live_binary_ends() {
    let live = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    let v = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    // both hold three pieces (w minted by the keeper from its deposit, v by itself) and sell them
    go(&mut env, 100, 90);
    let dep = sdk_deposit_for(&env, &cfg(&env, &k.pool), 3);
    buy_with_deposit(&mut env, &w, &k, SOL, dep);
    buy_with_deposit(&mut env, &v, &k, SOL, 0);
    go(&mut env, 103, 90);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]).unwrap();
    env.ok(&[cb(400_000), mint_ix(&v.pubkey(), &k, 3, 0, 3)], &[&v]);
    env.ok(&[cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), sell_all_ix(&env, &v.pubkey(), &k)], &[&w, &v]);
    let (wp, vp) = (newest_first(&env, &k, &w.pubkey()), newest_first(&env, &k, &v.pubkey()));

    // the same second round on two chains: the binary live on mainnet, and this one
    let growth = rent(&env, Ticket::space(3)) - rent(&env, Ticket::space(0));
    let fork = env.svm.clone();
    load(&mut env, &live);
    let (before, [held_old, left_old, cost_old]) = second_round(&mut env, &k, &w, &v, &keeper, &wp, &vp);
    env.svm = fork;
    load(&mut env, &new);
    let (after, [held_new, left_new, cost_new]) = second_round(&mut env, &k, &w, &v, &keeper, &wp, &vp);
    // the shrunk ticket held the growth in its deposit, and the mint took exactly the growth more
    assert_eq!((held_new - held_old, cost_new - cost_old, left_new), (growth, growth, left_old));
    assert_eq!(before.len(), after.len());
    for (b, a) in before.iter().zip(after.iter()) {
        assert_eq!(b, a, "account {} differs between the live binary and this one", b.0);
    }
    // what the first entries are: both tickets exactly as long as their three pieces
    assert_eq!((after[0].2.len(), after[1].2.len()), (Ticket::space(3), Ticket::space(3)));
    println!("shrunk and grown again: {} accounts byte for byte and lamport for lamport as under the live binary; the mint took {growth} more from a deposit {growth} larger", after.len());
    check_books(&env, &k, &[w.pubkey(), v.pubkey()], true, "second round");
}

// =========================================================================================
// Tickets the live binaries left longer than their list
// =========================================================================================

#[test]
fn r11_tickets_the_live_binaries_left_too_long_give_their_extra_back_after_the_upgrade() {
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r7);
    let (m, k) = plain_setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let (a, b, c, d) = (newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m));
    let stranger = env.user(SOL);
    let all = [a.pubkey(), b.pubkey(), c.pubkey(), d.pubkey()];
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));

    // under round 7: A buys three pieces and mints two with count 4; the old realloc grew its
    // ticket for four
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &a, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 4, 0, 2)], &[&a]);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), ticket(&env, &k.pool, &a.pubkey()).owned.len()), (Ticket::space(4), 2));
    // under round 8, the binary live now: B mints three, sells them all and settles; C mints
    // three and sends two to D
    go(&mut env, 110, 90);
    load(&mut env, &r8);
    go(&mut env, 111, 90);
    buy_with_deposit(&mut env, &b, &k, SOL, 0);
    buy_with_deposit(&mut env, &c, &k, SOL, 0);
    go(&mut env, 114, 90);
    env.ok(&[cb(400_000), mint_ix(&b.pubkey(), &k, 3, 0, 3)], &[&b]);
    env.ok(&[cb(400_000), mint_ix(&c.pubkey(), &k, 3, 0, 3)], &[&c]);
    env.ok(&[cb(600_000), sell_all_ix(&env, &b.pubkey(), &k)], &[&b]);
    let bp = newest_first(&env, &k, &b.pubkey());
    env.ok(&[cb(400_000), settle_ix(&b.pubkey(), &k, &b.pubkey(), &bp)], &[&b]);
    let cp = ticket(&env, &k.pool, &c.pubkey()).owned.clone();
    env.ok(&[cb(400_000), send_ix(&c.pubkey(), &k, &d.pubkey(), &[cp[1], cp[2]])], &[&c]);
    let lens = |env: &Env| all.map(|w| (ticket_len(env, &k.pool, &w), ticket(env, &k.pool, &w).owned.len()));
    assert_eq!(lens(&env), [(Ticket::space(4), 2), (Ticket::space(3), 0), (Ticket::space(3), 1), (Ticket::space(2), 2)]);
    assert_eq!(all.map(|w| deposit(&env, &k.pool, &w)), [0; 4], "the live binaries left no deposit: the extra rent is in the length");
    check_books(&env, &k, &all, true, "live binaries");

    // THE UPGRADE: nothing moves by itself
    go(&mut env, 119, 90);
    load(&mut env, &new);
    go(&mut env, 121, 90);
    check_books(&env, &k, &all, true, "right after the upgrade");
    assert_eq!(all.map(|w| deposit(&env, &k.pool, &w)), [0; 4]);

    // D, whose ticket is exactly as long as its list, sends one piece to A, whose ticket has
    // room for it: A's ticket does not grow, so D pays only its signature; D's ticket shrinks
    // and keeps that entry's rent as D's deposit; A's deposit stays 0
    let dp = ticket(&env, &k.pool, &d.pubkey()).owned.clone();
    let d0 = env.lamports(&d.pubkey());
    env.ok(&[cb(400_000), send_ix(&d.pubkey(), &k, &a.pubkey(), &[dp[1]])], &[&d]);
    assert_eq!(d0 - env.lamports(&d.pubkey()), fee, "no growth at a ticket with room: the sender pays nothing");
    assert_eq!(lens(&env), [(Ticket::space(4), 3), (Ticket::space(3), 0), (Ticket::space(3), 1), (Ticket::space(1), 1)]);
    assert_eq!(all.map(|w| deposit(&env, &k.pool, &w)), [0, 0, 0, entry]);

    // nobody else takes an old ticket's extra
    let mut ix = withdraw_ix(&stranger.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &b.pubkey());
    refused(&mut env, &[ix], &[&stranger], &["ConstraintSeeds"]);

    // each withdraws: A gets the rent of its one unused entry, B of three, C of two, D of one;
    // every ticket ends exactly as long as its list and exactly at its rent
    for (w, entries, list) in [(&a, 1u64, 3usize), (&b, 3, 0), (&c, 2, 1), (&d, 1, 1)] {
        let before = env.lamports(&w.pubkey());
        env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
        assert_eq!(env.lamports(&w.pubkey()), before + entries * entry - fee, "{} entries back", entries);
        assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), Ticket::space(list));
        assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), rent(&env, Ticket::space(list)));
        refused(&mut env, &[withdraw_ix(&w.pubkey(), &k.pool)], &[w], &["NoDeposit"]);
    }

    // A mints its waiting piece itself: the ticket grows again from A's wallet, as any ticket
    // exactly as long as its list does
    go(&mut env, 125, 90);
    let t = ticket(&env, &k.pool, &a.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (3, 1));
    let a0 = env.lamports(&a.pubkey());
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 1, t.minted, 1)], &[&a]);
    let asset = env.lamports(&asset_of(&k.pool, &a.pubkey(), t.minted));
    assert_eq!(a0 - env.lamports(&a.pubkey()), asset + entry + fee);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &a.pubkey())), (Ticket::space(4), 0));

    // an old ticket's next settle shrinks it too: C sells and settles its last piece
    env.ok(&[cb(600_000), sell_all_ix(&env, &c.pubkey(), &k)], &[&c]);
    let left = newest_first(&env, &k, &c.pubkey());
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &c.pubkey(), &left)], &[&stranger]);
    assert_eq!((ticket_len(&env, &k.pool, &c.pubkey()), deposit(&env, &k.pool, &c.pubkey())), (Ticket::space(0), entry));
    check_books(&env, &k, &all, true, "after the upgrade");
}

#[test]
fn r11_an_old_ticket_that_never_withdraws_shrinks_at_its_next_settle_or_send() {
    // a wallet that only ever sells: its first settle after the upgrade frees what the live
    // binary left, whatever the ticket's length was
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r7);
    let (m, k) = plain_setup(&mut env, 3);
    let a = newcomer(&mut env, &m);
    let b = newcomer(&mut env, &m);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &a, &k, SOL, 0);
    buy_with_deposit(&mut env, &b, &k, SOL, 0);
    go(&mut env, 103, 90);
    // both mint one piece with count 4: tickets grown for four
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 4, 0, 1)], &[&a]);
    env.ok(&[cb(400_000), mint_ix(&b.pubkey(), &k, 4, 0, 1)], &[&b]);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), ticket_len(&env, &k.pool, &b.pubkey())), (Ticket::space(4), Ticket::space(4)));
    go(&mut env, 119, 90);
    load(&mut env, &new);
    go(&mut env, 121, 90);
    // A sells and settles: the ticket shrinks from four entries to none
    env.ok(&[cb(600_000), sell_all_ix(&env, &a.pubkey(), &k)], &[&a]);
    let ap = newest_first(&env, &k, &a.pubkey());
    env.ok(&[cb(400_000), settle_ix(&a.pubkey(), &k, &a.pubkey(), &ap)], &[&a]);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &a.pubkey())), (Ticket::space(0), 4 * entry));
    // B sends its piece to A: B shrinks from four entries to none, A grows by one from B's wallet
    let bp = ticket(&env, &k.pool, &b.pubkey()).owned.clone();
    env.ok(&[cb(400_000), send_ix(&b.pubkey(), &k, &a.pubkey(), &bp)], &[&b]);
    assert_eq!((ticket_len(&env, &k.pool, &b.pubkey()), deposit(&env, &k.pool, &b.pubkey())), (Ticket::space(0), 4 * entry));
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &a.pubkey())), (Ticket::space(1), 4 * entry));
    check_books(&env, &k, &[a.pubkey(), b.pubkey()], true, "old tickets after a settle and a send");
}

// =========================================================================================
// The pegged coin: unchanged, and nothing counts twice
// =========================================================================================

/// A pegged coin's sell, plain transfers, a staged send, a reap and a deliver. Returns every
/// account they touch.
fn pegged_round(env: &mut Env, p: &Peg, e: &Keypair, f: &Keypair, g: &Keypair, stranger: &Keypair) -> Vec<(Pubkey, u64, Vec<u8>)> {
    let k = &p.k;
    go(env, 110, 90);
    // E sells down to two units: one piece burns into the queue, paid by the rent E's ticket frees
    let sell = peg_sell_ix(env, &e.pubkey(), k, coins(env, k, &e.pubkey()) - 2 * UNIT);
    env.ok(&[cb(400_000), sell], &[e]);
    // F keeps one unit and sends the rest to G: two pieces move, G grows on F's freed rent
    let send = coins(env, k, &f.pubkey()) - UNIT;
    env.ok(&[peg_transfer_ix(k, &f.pubkey(), &g.pubkey(), send)], &[f]);
    // a stranger reaps the queue and delivers G's pieces
    let q = queue(env, k);
    env.ok(&[cb(400_000), reap_ix(&stranger.pubkey(), k, &q)], &[stranger]);
    let gp = ticket(env, &k.pool, &g.pubkey()).owned.clone();
    env.ok(&[cb(400_000), deliver_ix(&stranger.pubkey(), k, &g.pubkey(), &gp)], &[stranger]);
    // E stages its first piece at the end of its list and sends it with one unit to G
    go(env, 112, 90);
    let ep = ticket(env, &k.pool, &e.pubkey()).owned.clone();
    let staged = [stage_ix(&e.pubkey(), k, &[ep[1]]), peg_transfer_ix(k, &e.pubkey(), &g.pubkey(), UNIT), deliver_ix(&e.pubkey(), k, &g.pubkey(), &[ep[1]])];
    env.ok(&[cb(400_000), staged[0].clone(), staged[1].clone(), staged[2].clone()], &[e]);
    let mut keys = vec![
        ticket_of(&k.pool, &e.pubkey()),
        ticket_of(&k.pool, &f.pubkey()),
        ticket_of(&k.pool, &g.pubkey()),
        queue_of(&k.pool),
        cfg_of(&k.pool),
        e.pubkey(),
        f.pubkey(),
        g.pubkey(),
        stranger.pubkey(),
    ];
    keys.extend((0..3).map(|i| asset_of(&k.pool, &e.pubkey(), i)));
    keys.extend((0..3).map(|i| asset_of(&k.pool, &f.pubkey(), i)));
    snapshot(env, &keys)
}

#[test]
fn r11_pegged_sells_transfers_reaps_and_deliveries_end_exactly_where_the_live_binary_ends() {
    // the decision for the pegged path: the transfer hook, stage, deliver and reap are not
    // changed. The transfer hook already shrinks the sender's ticket and pays the place its
    // pieces take (the receiver's ticket or the burn queue) from the rent that frees, against a
    // floor of the sender's own deposit; reap pays the queue's spare to the reaper. This test
    // runs the same pegged round under the live binary and under this one and compares every
    // account, then checks that the withdraw (which now shrinks first) finds nothing more.
    let live = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let fee = signature_fee(&mut env);
    let (e, f, g) = (peg_wallet(&mut env, &p), peg_wallet(&mut env, &p), peg_wallet(&mut env, &p));
    let stranger = env.user(SOL);
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &e.pubkey(), &k, SOL)], &[&e]);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &f.pubkey(), &k, SOL)], &[&f]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&e.pubkey(), &k, 3, 0, 3)], &[&e]);
    env.ok(&[cb(400_000), mint_ix(&f.pubkey(), &k, 3, 0, 3)], &[&f]);
    env.ok(&[deposit_ix(&e.pubkey(), &k.pool, 333_333)], &[&e]);
    env.ok(&[deposit_ix(&g.pubkey(), &k.pool, 777_777)], &[&g]);

    let fork = env.svm.clone();
    load(&mut env, &live);
    let before = pegged_round(&mut env, &p, &e, &f, &g, &stranger);
    env.svm = fork;
    load(&mut env, &new);
    let after = pegged_round(&mut env, &p, &e, &f, &g, &stranger);
    for (b, a) in before.iter().zip(after.iter()) {
        assert_eq!(b, a, "account {} differs between the live binary and this one", b.0);
    }
    let all = [e.pubkey(), f.pubkey(), g.pubkey()];
    // what the round did, on this chain
    assert_eq!(all.map(|w| ticket(&env, &k.pool, &w).owned.len()), [1, 1, 3]);
    for w in all {
        assert_eq!(ticket_len(&env, &k.pool, &w), Ticket::space(ticket(&env, &k.pool, &w).owned.len()), "the transfer hook left every ticket exactly as long as its list");
    }
    assert_eq!(all.map(|w| deposit(&env, &k.pool, &w)), [333_333, 0, 777_777], "no deposit paid for a move or a burn");
    // the withdraws return each deposit, no more: there was nothing left to shrink
    for (w, amount) in [(&e, 333_333u64), (&g, 777_777)] {
        let before = env.lamports(&w.pubkey());
        env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
        assert_eq!(env.lamports(&w.pubkey()), before + amount - fee);
    }
    refused(&mut env, &[withdraw_ix(&f.pubkey(), &k.pool)], &[&f], &["NoDeposit"]);
    check_books(&env, &k, &all, true, "pegged round");
}

#[test]
fn r11_pegged_an_old_ticket_with_room_pays_a_move_from_its_spare_rent_and_the_rest_comes_back_once() {
    // A ticket the round-7 binary grew for four pieces holding two. A transfer moves one of
    // them: the receiver's growth is paid from the sender's spare rent, the sender's ticket
    // shrinks to its list, and what is left over is the sender's deposit. Withdrawing before
    // the transfer or after it gives the sender the same in total: nothing counts twice.
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r7);
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let fee = signature_fee(&mut env);
    let (f, g) = (peg_wallet(&mut env, &p), peg_wallet(&mut env, &p));
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &f.pubkey(), &k, SOL)], &[&f]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&f.pubkey(), &k, 4, 0, 2)], &[&f]);
    assert_eq!((ticket_len(&env, &k.pool, &f.pubkey()), ticket(&env, &k.pool, &f.pubkey()).owned.len(), ticket(&env, &k.pool, &f.pubkey()).pending()), (Ticket::space(4), 2, 1));
    go(&mut env, 119, 90);
    load(&mut env, &new);
    go(&mut env, 121, 90);
    env.ok(&[deposit_ix(&g.pubkey(), &k.pool, 777_777)], &[&g]);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    let watched = [ticket_of(&k.pool, &f.pubkey()), ticket_of(&k.pool, &g.pubkey()), queue_of(&k.pool)];

    // F keeps one unit and sends the rest: its waiting piece is dropped, one minted piece moves
    let fork = env.svm.clone();
    let mut totals = vec![];
    for withdraw_first in [false, true] {
        env.svm = fork.clone();
        let f0 = env.lamports(&f.pubkey());
        if withdraw_first {
            env.ok(&[withdraw_ix(&f.pubkey(), &k.pool)], &[&f]);
            assert_eq!((ticket_len(&env, &k.pool, &f.pubkey()), deposit(&env, &k.pool, &f.pubkey())), (Ticket::space(2), 0));
        }
        let sum0 = lamports_of(&env, &watched);
        let send = coins(&env, &k, &f.pubkey()) - UNIT;
        env.ok(&[peg_transfer_ix(&k, &f.pubkey(), &g.pubkey(), send)], &[&f]);
        let (tf, tg) = (ticket(&env, &k.pool, &f.pubkey()), ticket(&env, &k.pool, &g.pubkey()));
        assert_eq!((tf.owned.len(), tf.pending(), tg.owned.len()), (1, 0, 1));
        assert_eq!(lamports_of(&env, &watched), sum0, "the transfer only moved rent between the two tickets and the queue");
        assert_eq!((ticket_len(&env, &k.pool, &f.pubkey()), ticket_len(&env, &k.pool, &g.pubkey())), (Ticket::space(1), Ticket::space(1)));
        assert_eq!(deposit(&env, &k.pool, &g.pubkey()), 777_777, "the receiver's deposit paid nothing");
        assert_eq!(deposit(&env, &k.pool, &f.pubkey()), if withdraw_first { 0 } else { 2 * entry });
        if !withdraw_first {
            env.ok(&[withdraw_ix(&f.pubkey(), &k.pool)], &[&f]);
        }
        // F signed two transactions either way: the withdraw and the transfer
        let got = env.lamports(&f.pubkey()) + 2 * fee - f0;
        assert_eq!(env.lamports(&ticket_of(&k.pool, &f.pubkey())), rent(&env, Ticket::space(1)));
        totals.push(got);
        check_books(&env, &k, &[f.pubkey(), g.pubkey()], false, "an old pegged ticket");
    }
    assert_eq!(totals, vec![2 * entry, 2 * entry], "the same back to F in either order: its two unused entries");
}

#[test]
fn r11_pegged_the_settle_backstop_shrinks_the_ticket_too() {
    // with the burn queue at its ceiling a transfer leaves its unbacked pieces on the sender's
    // list; anyone's settle burns them, and since round 11 the ticket then shrinks to its list
    let mut env = Env::new();
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let fee = signature_fee(&mut env);
    let e = peg_wallet(&mut env, &p);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &e.pubkey(), &k, SOL)], &[&e]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&e.pubkey(), &k, 3, 0, 3)], &[&e]);
    env.ok(&[deposit_ix(&e.pubkey(), &k.pool, 444_444)], &[&e]);
    // the queue at its ceiling (state injected: burned pieces nobody reaped)
    let key = queue_of(&k.pool);
    let acc = env.svm.get_account(&key).unwrap();
    let full = hook_collectible::MAX_QUEUE;
    let mut data = acc.data.clone();
    data.resize(Q_ENTRIES + 32 * full, 7);
    data[Q_COUNT..Q_COUNT + 4].copy_from_slice(&(full as u32).to_le_bytes());
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(key, Account { lamports, data, owner: acc.owner, executable: false, rent_epoch: acc.rent_epoch }).unwrap();
    // E sells down to one unit: nothing can burn into the queue, the pieces stay listed
    let sell = peg_sell_ix(&env, &e.pubkey(), &k, coins(&env, &k, &e.pubkey()) - UNIT);
    env.ok(&[cb(400_000), sell], &[&e]);
    assert_eq!((ticket(&env, &k.pool, &e.pubkey()).owned.len(), ticket_len(&env, &k.pool, &e.pubkey())), (3, Ticket::space(3)));
    let t_lamports = env.lamports(&ticket_of(&k.pool, &e.pubkey()));
    // the keeper settles: it gets the two assets' lamports, the ticket's freed rent stays E's
    let burn = newest_first(&env, &k, &e.pubkey());
    let in_assets = lamports_of(&env, &burn);
    let k0 = env.lamports(&keeper.pubkey());
    env.ok(&[cb(400_000), settle_ix(&keeper.pubkey(), &k, &e.pubkey(), &burn)], &[&keeper]);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    assert_eq!(env.lamports(&keeper.pubkey()) + fee - k0, in_assets - lamports_of(&env, &burn));
    assert_eq!(env.lamports(&ticket_of(&k.pool, &e.pubkey())), t_lamports);
    assert_eq!((ticket_len(&env, &k.pool, &e.pubkey()), deposit(&env, &k.pool, &e.pubkey())), (Ticket::space(1), 444_444 + 2 * entry));
    assert_eq!(queue(&env, &k).len(), full, "the queue was not touched");
    check_books(&env, &k, &[e.pubkey()], true, "pegged settle backstop");
}

// =========================================================================================
// A random walk on a plain coin: a shrink frees exactly the rent of what left, nothing else
// =========================================================================================

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Buy,
    KeeperMint,
    OwnMint,
    Sell,
    SellAndSettle,
    Settle,
    Send,
    Withdraw,
    CoinsAway,
}

#[test]
fn r11_a_random_walk_on_a_plain_coin_frees_exactly_the_rent_of_what_left_and_moves_nothing_else() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 3);
    let wallets: Vec<Keypair> = (0..4).map(|_| newcomer(&mut env, &m)).collect();
    let keys: Vec<Pubkey> = wallets.iter().map(|w| w.pubkey()).collect();
    let keeper = env.user(20 * SOL);
    let stranger = env.user(20 * SOL);
    let ops = [Op::Buy, Op::Buy, Op::KeeperMint, Op::OwnMint, Op::Sell, Op::SellAndSettle, Op::Settle, Op::Send, Op::Withdraw, Op::CoinsAway];
    let mut seed = 0x2545F4914F6CDD1Du64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut slot = 100u64;
    let mut counts = std::collections::BTreeMap::<String, (u32, u32)>::new();
    let mut freed_total = 0u64;
    for step in 0..500 {
        slot += 1 + rnd() % 2;
        go(&mut env, slot, slot - 60);
        let i = (rnd() % 4) as usize;
        let j = (i + 1 + (rnd() % 3) as usize) % 4;
        let (w, to) = (&wallets[i], &wallets[j]);
        let op = ops[(rnd() % ops.len() as u64) as usize];
        // every ticket before the step: (lamports, length, deposit)
        let state = |env: &Env| -> Vec<Option<(u64, usize, u64)>> {
            keys.iter()
                .map(|u| env.svm.get_account(&ticket_of(&k.pool, u)).filter(|a| !a.data.is_empty()).map(|a| (a.lamports, a.data.len(), a.lamports - rent(env, a.data.len()))))
                .collect()
        };
        let before = state(&env);
        let mut dep_in = 0u64;
        let has_ticket = exists(&env, &ticket_of(&k.pool, &w.pubkey()));
        let ok = match op {
            Op::Buy => {
                let amount = SOL / 10 * (1 + rnd() % 5);
                dep_in = if rnd() % 2 == 0 { sdk_deposit_for(&env, &cfg(&env, &k.pool), 3) } else { 0 };
                let mut ixs = vec![cb(400_000)];
                if !has_ticket {
                    ixs.push(open_ticket_ix(&w.pubkey(), &k.pool));
                }
                ixs.push(buy_ix(&env, &w.pubkey(), &k, amount));
                if dep_in > 0 {
                    ixs.push(deposit_ix(&w.pubkey(), &k.pool, dep_in));
                }
                env.send(&ixs, &[w]).is_ok()
            }
            Op::KeeperMint | Op::OwnMint if has_ticket => {
                let t = ticket(&env, &k.pool, &w.pubkey());
                let n = t.pending().min(4);
                if op == Op::KeeperMint {
                    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), t.minted, n.max(1))]).is_ok()
                } else {
                    env.send(&[cb(400_000), mint_ix(&w.pubkey(), &k, n as u8, t.minted, n)], &[w]).is_ok()
                }
            }
            Op::Sell | Op::SellAndSettle if coins(&env, &k, &w.pubkey()) > 0 => {
                let have = coins(&env, &k, &w.pubkey());
                let amount = if rnd() % 3 == 0 { have } else { have / (2 + rnd() % 3) };
                let mut ixs = vec![cb(600_000), sell_ix(&env, &w.pubkey(), &k, amount.max(1))];
                if op == Op::SellAndSettle && has_ticket {
                    let burn: Vec<Pubkey> = newest_first(&env, &k, &w.pubkey()).into_iter().take(6).collect();
                    ixs.push(settle_ix(&w.pubkey(), &k, &w.pubkey(), &burn));
                }
                env.send(&ixs, &[w]).is_ok()
            }
            Op::Settle if has_ticket => {
                let burn: Vec<Pubkey> = newest_first(&env, &k, &w.pubkey()).into_iter().take(6).collect();
                let payer = if rnd() % 2 == 0 { &stranger } else { w };
                env.send(&[cb(400_000), settle_ix(&payer.pubkey(), &k, &w.pubkey(), &burn)], &[payer]).is_ok()
            }
            Op::Send if has_ticket && !ticket(&env, &k.pool, &w.pubkey()).owned.is_empty() => {
                let owned = ticket(&env, &k.pool, &w.pubkey()).owned.clone();
                let n = (1 + (rnd() % 2) as usize).min(owned.len());
                let pick: Vec<Pubkey> = owned.iter().rev().take(n).cloned().collect();
                env.send(&[cb(400_000), send_ix(&w.pubkey(), &k, &to.pubkey(), &pick)], &[w]).is_ok()
            }
            Op::Withdraw if has_ticket => env.send(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]).is_ok(),
            Op::CoinsAway if coins(&env, &k, &w.pubkey()) > 0 => {
                let have = coins(&env, &k, &w.pubkey());
                env.send(&[coin_transfer_ix(&k, &w.pubkey(), &to.pubkey(), have / (1 + rnd() % 3))], &[w]).is_ok()
            }
            _ => continue,
        };
        let c = counts.entry(format!("{op:?}")).or_insert((0, 0));
        if ok { c.0 += 1 } else { c.1 += 1 }
        let after = state(&env);
        for (u, (b, a)) in before.iter().zip(after.iter()).enumerate() {
            let what = format!("step {step} {op:?} by wallet {i} to {j}, ok {ok}: ticket {u}");
            let Some((la, len_a, da)) = *a else {
                assert!(b.is_none(), "{what}: a ticket disappeared");
                continue;
            };
            let t = ticket(&env, &k.pool, &keys[u]);
            assert!(la >= rent(&env, len_a), "{what}: below its rent");
            assert!(len_a >= Ticket::space(t.owned.len()), "{what}: shorter than its list");
            if !ok {
                assert_eq!(*b, *a, "{what}: a refused step changed a ticket");
                continue;
            }
            if u == i && matches!(op, Op::Settle | Op::SellAndSettle | Op::Send | Op::Withdraw) {
                assert_eq!(len_a, Ticket::space(t.owned.len()), "{what}: not shrunk to its list");
            }
            let Some((lb, len_b, db)) = *b else {
                // a ticket opened in this step: a buy's own (its deposit is what the buy paid
                // in) or a send's receiver (exactly its rent)
                assert!((u == i && op == Op::Buy) || (u == j && op == Op::Send), "{what}: a ticket opened by someone else");
                assert_eq!(da, if op == Op::Buy { dep_in } else { 0 }, "{what}: a new ticket's deposit");
                continue;
            };
            let touched_by_mint = u == i && matches!(op, Op::KeeperMint | Op::OwnMint);
            match (u == i, u == j, op) {
                // what the settle, the send or the withdraw shrank: no lamport left (except a
                // withdraw's own payout), and the deposit grew by exactly the rent freed
                (true, _, Op::Settle | Op::SellAndSettle | Op::Send) => {
                    assert_eq!(la, lb, "{what}: lamports left a shrinking ticket");
                    assert_eq!(da - db, rent(&env, len_b) - rent(&env, len_a), "{what}: the deposit did not grow by exactly the rent freed");
                    freed_total += da - db;
                }
                (true, _, Op::Withdraw) => {
                    assert_eq!((la, da), (rent(&env, len_a), 0), "{what}: a withdraw leaves exactly the rent");
                }
                (true, _, Op::Buy) => {
                    assert_eq!((la - lb, len_a, da - db), (dep_in, len_b, dep_in), "{what}: a buy adds its deposit and nothing else");
                }
                // the receiver of a send keeps its deposit; its ticket only grows
                (false, true, Op::Send) => {
                    assert_eq!(da, db, "{what}: the receiver's deposit moved");
                    assert!(len_a >= len_b);
                }
                _ if touched_by_mint => {
                    assert!(len_a >= len_b, "{what}: a mint shrank a ticket");
                }
                _ => assert_eq!((lb, len_b), (la, len_a), "{what}: a ticket nobody named changed"),
            }
        }
        check_books(&env, &k, &keys, true, &format!("step {step} {op:?}"));
    }
    println!("random walk: (ok, refused) per kind {counts:?}; {freed_total} lamports of rent freed into deposits");
    assert!(freed_total > 0, "the walk freed some rent");
    for kind in ["Settle", "Send", "Withdraw", "KeeperMint", "SellAndSettle"] {
        assert!(counts.get(kind).map(|c| c.0).unwrap_or(0) > 0, "the walk ran a {kind} that landed");
    }
}

