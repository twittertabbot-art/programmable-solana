//! Round 11, independent review of the ticket shrink in hook_collectible.
//!
//! The change: `shrink_to_fit` resizes a ticket down to exactly its list (`Ticket::space`) at
//! the end of `settle`, at the end of the sender's `send_pieces`, and first thing in
//! `withdraw_deposit`. No lamport moves; the rent it frees is above the rent of the new size,
//! which by round 8's definition makes it the wallet's deposit.
//!
//! Every test below is an attack on that change, or a check of a claim it makes, written by a
//! reviewer who did not write it. A test that passes means the attack failed, EXCEPT the tests
//! whose name starts with `finding_`: those reproduce a behaviour this review reports, and they
//! pass while it is there.
//!
//! What is attacked: a stranger's settle used to shrink a wallet's ticket and then to spend the
//! rent it frees (`mint_for`), and what that chain is worth to the stranger; the exact deposit
//! boundary of a keeper's mint before and after a stranger's shrink; a shrink and a growth of the
//! same ticket inside one transaction (realloc limits, stale bytes, the Anchor exit write); the
//! pegged coin's own shrink-and-pay meeting the new shrink; every way to reach the freed rent
//! other than the wallet's own; a random walk of transactions of one to three instructions with
//! a lamport ledger over every account; compute against the binary live on mainnet, a list at
//! its cap, a rollback to the live binary; and the arithmetic of the SDK's withdraw offer.
//!
//! The upgrade tests load the binaries that were live on mainnet:
//! `tests/fixtures/hook_collectible_live_r7.so` (round 7, 83939dca...835a: its `mint` grew a
//! ticket for `count` pieces even when it minted fewer) and
//! `tests/fixtures/hook_collectible_live_r8.so` (round 8, 5312fa58...e569, live now).

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hook_collectible::{CollectionConfig, Ticket, KEEPER_FEE, QUEUE_SEED, Q_COUNT, Q_ENTRIES, SLOT_HASHES_ID, VALIDATION_SEED};
use hookpool_interface::*;
use hookpool_tests::*;
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
fn coins_of(k: &PoolKeys, wallet: &Pubkey) -> Pubkey {
    ata_with(wallet, &k.base_mint, &k.base_program)
}
fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn hook_for(pool: &Pubkey, user: &Pubkey) -> HookRef {
    HookRef {
        program: pid(),
        treasury: system_program::ID,
        extra: vec![AccountMeta::new(cfg_of(pool), false), AccountMeta::new(ticket_of(pool, user), false), AccountMeta::new_readonly(SLOT_HASHES_ID, false)],
    }
}
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
fn open_ticket_for_ix(payer: &Pubkey, pool: &Pubkey, wallet: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OpenTicketFor { payer: *payer, ticket: ticket_of(pool, wallet), system_program: system_program::ID }.to_account_metas(None),
        data: hook_collectible::instruction::OpenTicketFor { pool: *pool, wallet: *wallet }.data(),
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
fn reorder_ix(user: &Pubkey, k: &PoolKeys, from: u32, to: u32) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::Reorder { user: *user, cfg: cfg_of(&k.pool), ticket: ticket_of(&k.pool, user), coins: coins_of(k, user) }.to_account_metas(None),
        data: hook_collectible::instruction::Reorder { from, to }.data(),
    }
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
/// The transfer hook's `execute` sent by hand, not by Token-2022.
#[allow(clippy::too_many_arguments)]
fn forged_execute_ix(k: &PoolKeys, source: &Pubkey, destination: &Pubkey, from_ticket: &Pubkey, to_ticket: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::Execute {
            source: *source,
            mint: k.base_mint,
            destination: *destination,
            authority: *source,
            validation: validation_of(&k.base_mint),
            cfg: cfg_of(&k.pool),
            from_ticket: *from_ticket,
            to_ticket: *to_ticket,
            queue: queue_of(&k.pool),
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::Execute { amount }.data(),
    }
}
/// The deposit: a plain SOL transfer from the wallet to its own ticket.
fn deposit_ix(user: &Pubkey, pool: &Pubkey, lamports: u64) -> Instruction {
    system_instruction::transfer(user, &ticket_of(pool, user), lamports)
}
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
fn cb(units: u32) -> Instruction {
    compute_budget_ix(units)
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
fn deposit(env: &Env, pool: &Pubkey, user: &Pubkey) -> u64 {
    let a = env.svm.get_account(&ticket_of(pool, user)).expect("a ticket");
    a.lamports.saturating_sub(rent(env, a.data.len()))
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
fn queue(env: &Env, k: &PoolKeys) -> Vec<Pubkey> {
    let d = env.svm.get_account(&queue_of(&k.pool)).unwrap().data;
    let n = u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
    (0..n).map(|i| Pubkey::new_from_array(d[Q_ENTRIES + 32 * i..Q_ENTRIES + 32 * (i + 1)].try_into().unwrap())).collect()
}
fn lamports_of(env: &Env, keys: &[Pubkey]) -> u64 {
    keys.iter().map(|a| env.lamports(a)).sum()
}
type Snap = Vec<(Pubkey, u64, Vec<u8>)>;
fn snapshot(env: &Env, keys: &[Pubkey]) -> Snap {
    keys.iter().map(|a| env.svm.get_account(a).map(|x| (*a, x.lamports, x.data)).unwrap_or((*a, 0, vec![]))).collect()
}
fn same(a: &Snap, b: &Snap, what: &str) {
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(x, y, "{what}: account {} differs", x.0);
    }
}
fn signature_fee(env: &mut Env) -> u64 {
    let k = env.user(SOL);
    let before = env.lamports(&k.pubkey());
    env.ok(&[compute_budget_ix(10_000)], &[&k]);
    before - env.lamports(&k.pubkey())
}
/// Exactly what a `mint_for` of `n` pieces costs the wallet's deposit now (at the ticket's
/// current length): the ticket's growth, each asset's rent and Core's fee, one keeper fee.
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
fn sdk_deposit_for(env: &Env, c: &CollectionConfig, pieces: u32) -> u64 {
    let locked = c.owner == Pubkey::default();
    let asset = if locked { 75 + c.name.len() + 2 + 10 + c.uri_base.len() + 68 } else { SDK_OPEN_ASSET_SIZE };
    (rent(env, asset) + CORE_FEE + (rent(env, 32) - rent(env, 0)) + KEEPER_FEE) * pieces as u64
}
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
/// Each ticket at least its rent and at least as long as its list, the config's counters equal
/// to what the tickets hold, and (`delivered`) every listed piece in its holder's hands.
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
/// The ticket's bytes are exactly its borsh serialization: nothing after the list, nothing stale.
fn exact_bytes(env: &Env, pool: &Pubkey, user: &Pubkey, what: &str) {
    let raw = env.svm.get_account(&ticket_of(pool, user)).unwrap().data;
    let mut want = Vec::new();
    ticket(env, pool, user).try_serialize(&mut want).unwrap();
    assert_eq!(raw, want, "{what}: the ticket holds bytes beyond its contents");
}

// ---- a plain coin -------------------------------------------------------------------------

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
fn newest_first(env: &Env, k: &PoolKeys, user: &Pubkey) -> Vec<Pubkey> {
    ticket(env, &k.pool, user).owned.iter().rev().cloned().collect()
}
/// Under round 7: `w` buys for `sol` (no deposit: round 7 had none), and at `at + 3` mints `n`
/// pieces asking for `count`. Round 7's `mint` grew the ticket for `count` pieces.
fn r7_long_ticket(env: &mut Env, k: &PoolKeys, w: &Keypair, sol: u64, count: u8, n: u32, at: u64) {
    go(env, at, at - 10);
    buy_with_deposit(env, w, k, sol, 0);
    go(env, at + 3, at - 10);
    let first = ticket(env, &k.pool, &w.pubkey()).minted;
    env.ok(&[cb(400_000), mint_ix(&w.pubkey(), k, count, first, n)], &[w]);
}
/// Under round 8: `w` buys `rounds` times for 1 SOL (four pieces each) and mints them itself,
/// then sells everything and settles. Round 8 never shrinks a plain coin's ticket, so it stays as
/// long as all the pieces it ever held, with an empty list. Returns the next free slot.
fn r8_sold_ticket(env: &mut Env, k: &PoolKeys, w: &Keypair, rounds: u32, at: u64) -> u64 {
    let mut slot = at;
    for _ in 0..rounds {
        go(env, slot, slot - 10);
        buy_with_deposit(env, w, k, SOL, 0);
        go(env, slot + 3, slot - 10);
        let t = ticket(env, &k.pool, &w.pubkey());
        let n = t.pending().min(4);
        env.ok(&[cb(400_000), mint_ix(&w.pubkey(), k, n as u8, t.minted, n)], &[w]);
        slot += 5;
    }
    env.ok(&[cb(600_000), sell_all_ix(env, &w.pubkey(), k)], &[w]);
    while !ticket(env, &k.pool, &w.pubkey()).owned.is_empty() {
        let burn: Vec<Pubkey> = newest_first(env, k, &w.pubkey()).into_iter().take(8).collect();
        env.ok(&[cb(1_000_000), settle_ix(&w.pubkey(), k, &w.pubkey(), &burn)], &[w]);
    }
    slot
}

// ---- a pegged coin ------------------------------------------------------------------------

struct Peg {
    k: PoolKeys,
    authority: Keypair,
}
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
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    assert_eq!(hexs(&hashv(&[&bytes]).to_bytes()), sha256, "the fixture {name} is the binary that was live");
    bytes
}
fn load(env: &mut Env, bytes: &[u8]) {
    env.svm.add_program(pid(), bytes).unwrap();
    let admin = env.admin.pubkey();
    env.patch_upgrade_authority(&pid(), Some(admin));
}

// =========================================================================================
// 1. A stranger's settle, then a stranger's mint_for out of the rent it freed
// =========================================================================================

#[test]
fn finding_i1_freed_rent_is_a_deposit_any_keeper_may_spend_on_the_wallets_own_pieces() {
    // FINDING I1 (informational, a design consequence the owner should know). Before round 11 a
    // plain coin's ticket had a deposit only when its wallet sent one. Now the rent a shrink frees
    // is a deposit too, and a stranger may make the shrink happen (`settle` is permissionless and
    // shrinks a fully backed ticket as well). Like every deposit it then pays any sender's
    // `mint_for` of the wallet's decided pieces. Here a wallet that never deposited, that minted
    // and sold twenty pieces under the live binary (its ticket kept their twenty entries) and then
    // bought one more piece without a deposit, has that piece minted by a stranger right after the
    // upgrade. The stranger's whole take is one KEEPER_FEE; the piece is the wallet's; what the
    // mint did not use the wallet withdraws. Under the live binary the same mint is refused (no
    // deposit), and the twenty entries' rent was out of everyone's reach, the wallet's included.
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r8);
    let (m, k) = plain_setup(&mut env, 5);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let stranger = env.user(SOL);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    let slot = r8_sold_ticket(&mut env, &k, &w, 5, 100);
    go(&mut env, slot, slot - 10);
    buy_with_deposit(&mut env, &w, &k, SOL / 4, 0);
    go(&mut env, slot + 3, slot - 10);
    let t = ticket(&env, &k.pool, &w.pubkey());
    let long = ticket_len(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending(), t.minted, long), (0, 1, 20, Ticket::space(20)));
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 0, "the live binary left no deposit: the extra rent is in the length");
    let extra = 20 * entry;

    go(&mut env, slot + 9, slot - 10);
    let before_upgrade = env.svm.clone();
    // the live binary: no deposit, no mint for the wallet; a settle shrinks nothing
    go(&mut env, slot + 11, slot - 10);
    refused(&mut env, &[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 20, 1)], &[&stranger], &["DepositTooSmall"]);
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
    assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), deposit(&env, &k.pool, &w.pubkey())), (long, 0));

    // this binary, path A: the wallet withdraws first and takes all of it, once
    env.svm = before_upgrade.clone();
    load(&mut env, &new);
    go(&mut env, slot + 11, slot - 10);
    let after_upgrade = env.svm.clone();
    let w0 = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()) + fee - w0, extra, "the twenty unused entries come back to the wallet");
    refused(&mut env, &[withdraw_ix(&w.pubkey(), &k.pool)], &[&w], &["NoDeposit"]);

    // path B: a stranger is first. Its settle burns nothing (the wallet is backed) and shrinks
    env.svm = after_upgrade;
    let s0 = env.lamports(&stranger.pubkey());
    let t_lamports = env.lamports(&ticket_of(&k.pool, &w.pubkey()));
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
    assert_eq!(s0 - env.lamports(&stranger.pubkey()), fee, "the settle paid the stranger nothing");
    assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), t_lamports, "no lamport left the ticket");
    assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), deposit(&env, &k.pool, &w.pubkey())), (Ticket::space(0), extra));
    // then mints the wallet's decided piece into the wallet, paid by that deposit
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 1);
    assert!(cost < extra);
    let s1 = env.lamports(&stranger.pubkey());
    keeper_send(&mut env, &stranger, &[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 20, 1)]).unwrap();
    let piece = asset_of(&k.pool, &w.pubkey(), 20);
    assert_eq!(env.lamports(&stranger.pubkey()), s1 + KEEPER_FEE - fee, "the stranger's whole take is one keeper fee");
    assert_eq!(core_owner(&env, &piece), w.pubkey(), "the piece is the wallet's");
    assert_eq!(t_lamports - env.lamports(&ticket_of(&k.pool, &w.pubkey())), env.lamports(&piece) + KEEPER_FEE, "the ticket paid the asset and one fee, nothing else");
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), extra - cost, "the deposit paid exactly the mint's cost");
    // bounded: nothing more to mint, no way to the rest
    refused(&mut env, &[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 21, 1)], &[&stranger], &["NothingToMint"]);
    let mut ix = withdraw_ix(&stranger.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &w.pubkey());
    refused(&mut env, &[ix], &[&stranger], &["ConstraintSeeds"]);
    let w0 = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()) + fee - w0, extra - cost);
    assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), rent(&env, Ticket::space(1)));
    check_books(&env, &k, &[w.pubkey()], true, "after a stranger's settle and mint");
    println!("FINDING I1: a stranger turned {extra} lamports of freed rent into the wallet's piece ({cost} lamports of it) and earned {KEEPER_FEE}");
}

#[test]
fn finding_i1_part2_a_sell_built_before_a_keepers_mint_from_freed_rent_hands_the_rent_to_the_next_settler() {
    // FINDING I1, continued. Round 8's I1 (a sell that meets the keeper's mint names a stale
    // list, so its own settle burns nothing and the next settler takes the new pieces' rent) now
    // also reaches wallets that never deposited: the deposit can be rent a shrink freed. Nothing
    // fails: the sell lands, the peg is restored by the next settle, the pieces were the
    // wallet's. Round 8's proposed fix (the sell's settle names the wallet's next asset
    // addresses) covers this case too, and the test shows it.
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r8);
    let (m, k) = plain_setup(&mut env, 5);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let stranger = env.user(SOL);
    let slot = r8_sold_ticket(&mut env, &k, &w, 5, 100);
    go(&mut env, slot, slot - 10);
    buy_with_deposit(&mut env, &w, &k, SOL / 4, 0);
    go(&mut env, slot + 9, slot - 10);
    load(&mut env, &new);
    go(&mut env, slot + 11, slot - 10);
    let fork = env.svm.clone();
    // everything of the wallet's in lamports: its own and its whole ticket (rent included)
    let total = |env: &Env| env.lamports(&w.pubkey()) + env.lamports(&ticket_of(&k.pool, &w.pubkey()));
    let next = asset_of(&k.pool, &w.pubkey(), 20);

    // the reference: the wallet's sell and settle land first; its waiting piece is dropped
    let sell = vec![cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[])];
    let before = total(&env);
    env.ok(&sell, &[&w]);
    let cost_ref = before - total(&env);
    assert_eq!(cost_ref, fee);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (0, 0));

    // A: the same sell lands after a stranger's settle and mint_for
    env.svm = fork.clone();
    let sell = vec![cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[])];
    let before = total(&env);
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
    env.ok(&[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 20, 1)], &[&stranger]);
    env.ok(&sell, &[&w]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 1, "the sell landed; its settle burned nothing");
    let s0 = env.lamports(&stranger.pubkey());
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[next])], &[&stranger]);
    let gain = env.lamports(&stranger.pubkey()) + fee - s0;
    let cost_a = before - total(&env);
    println!("FINDING I1 part 2: the wallet lost {cost_a} lamports (reference {cost_ref}); the next settler received {gain}, the minting stranger {KEEPER_FEE}; Core's fee stays in the burned asset");
    assert!(ticket(&env, &k.pool, &w.pubkey()).owned.is_empty(), "the next settle restored the peg");
    assert!(gain > 1_000_000, "the next settler took the asset's rent");

    // C: round 8's proposal: the sell's settle names the next address too; the seller keeps it
    env.svm = fork;
    let sell = vec![cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[next])];
    let before = total(&env);
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
    env.ok(&[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 20, 1)], &[&stranger]);
    env.ok(&sell, &[&w]);
    assert!(ticket(&env, &k.pool, &w.pubkey()).owned.is_empty(), "the seller burned it itself");
    let cost_c = before - total(&env);
    println!("with the next address named the wallet lost {cost_c} lamports (the keeper fee, the one-byte rent left in the burned asset, its signature)");
    assert_eq!(cost_a - cost_c, gain, "what the next settler got in A comes back to the seller in C");
    check_books(&env, &k, &[w.pubkey()], true, "after the sell");
}

// =========================================================================================
// 2. The keeper's exact boundary, before and after a stranger's shrink
// =========================================================================================

#[test]
fn rev11_a_strangers_shrink_never_makes_a_keepers_mint_or_the_wallets_own_mint_fail_or_cost_more() {
    // A keeper sizes and simulates `mint_for` against the ticket as it is. A stranger's settle
    // lands first and shrinks the ticket. The deposit grows by exactly the rent the shrink frees
    // and the mint's growth by at most that, so a mint that fit still fits and one that did not
    // still does not: the boundary does not move by a lamport. Both a ticket with room for every
    // piece and one with room for some are tried, at the exact deposit and one lamport under.
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let new = so("hook_collectible");
    for (room_for_all, sol) in [(true, SOL), (false, 2 * SOL)] {
        for under in [0u64, 1] {
            let mut env = Env::new();
            go(&mut env, 5, 0);
            load(&mut env, &r7);
            let (m, k) = plain_setup(&mut env, 5);
            let w = newcomer(&mut env, &m);
            let keeper = env.user(SOL);
            let stranger = env.user(SOL);
            // round 7: the ticket grown for four, holding one
            r7_long_ticket(&mut env, &k, &w, sol, 4, 1, 100);
            go(&mut env, 119, 90);
            load(&mut env, &new);
            go(&mut env, 121, 90);
            let t = ticket(&env, &k.pool, &w.pubkey());
            let n = t.pending().min(4);
            assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), n), (Ticket::space(4), if room_for_all { 3 } else { 4 }));
            let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), n);
            env.ok(&[deposit_ix(&w.pubkey(), &k.pool, cost - under)], &[&w]);
            let ix = mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 1, n);
            let mut keys = vec![ticket_of(&k.pool, &w.pubkey()), w.pubkey(), keeper.pubkey(), cfg_of(&k.pool), collection_of(&k.pool)];
            keys.extend((0..6).map(|i| asset_of(&k.pool, &w.pubkey(), i)));
            let fork = env.svm.clone();
            let case = format!("room for all {room_for_all}, {under} under");

            // A: the keeper alone
            let a = keeper_send(&mut env, &keeper, &[cb(400_000), ix.clone()]);
            let snap_a = snapshot(&env, &keys);
            // B: a stranger's settle lands first, then the same instruction
            env.svm = fork.clone();
            env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
            assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), Ticket::space(1), "{case}: the stranger's settle shrank the ticket");
            let b = keeper_send(&mut env, &keeper, &[cb(400_000), ix.clone()]);
            let snap_b = snapshot(&env, &keys);
            if under == 0 {
                assert!(a.is_ok() && b.is_ok(), "{case}: {a:?} {b:?}");
                same(&snap_a, &snap_b, &case);
                assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), deposit(&env, &k.pool, &w.pubkey())), (Ticket::space(1 + n as usize), 0));
                check_books(&env, &k, &[w.pubkey()], true, &case);
            } else {
                assert!(a.unwrap_err().contains("DepositTooSmall") && b.unwrap_err().contains("DepositTooSmall"), "{case}");
            }

            // the wallet's own mint, deposit or not: the same lamports with and without the shrink
            env.svm = fork.clone();
            env.ok(&[cb(400_000), mint_ix(&w.pubkey(), &k, n as u8, 1, n)], &[&w]);
            let own_a = snapshot(&env, &keys);
            env.svm = fork;
            env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
            env.ok(&[cb(400_000), mint_ix(&w.pubkey(), &k, n as u8, 1, n)], &[&w]);
            same(&own_a, &snapshot(&env, &keys), &format!("{case}: the wallet's own mint"));
        }
    }
}

// =========================================================================================
// 3. A shrink and a growth of the same ticket in one transaction
// =========================================================================================

/// Two wallets under round 8 with four pieces each; each moves its coins away down to two units
/// and settles (round 8 does not shrink: two stale entries stay in each ticket's spare bytes);
/// W then buys two more pieces, decided by the time this returns. Then the upgrade.
fn two_round8_tickets_with_stale_room(env: &mut Env) -> (Market, PoolKeys, Keypair, Keypair, Keypair) {
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    go(env, 5, 0);
    load(env, &r8);
    let (m, k) = plain_setup(env, 5);
    let w = newcomer(env, &m);
    let v = newcomer(env, &m);
    let sink = newcomer(env, &m);
    go(env, 100, 90);
    buy_with_deposit(env, &w, &k, SOL, 0);
    buy_with_deposit(env, &v, &k, SOL, 0);
    go(env, 103, 90);
    for x in [&w, &v] {
        env.ok(&[cb(400_000), mint_ix(&x.pubkey(), &k, 4, 0, 4)], &[x]);
        let away = coins(env, &k, &x.pubkey()) - 2 * UNIT;
        env.ok(&[coin_transfer_ix(&k, &x.pubkey(), &sink.pubkey(), away)], &[x]);
        let burn = newest_first(env, &k, &x.pubkey());
        env.ok(&[cb(400_000), settle_ix(&x.pubkey(), &k, &x.pubkey(), &burn)], &[x]);
        assert_eq!((ticket(env, &k.pool, &x.pubkey()).owned.len(), ticket_len(env, &k.pool, &x.pubkey())), (2, Ticket::space(4)));
        let raw = env.svm.get_account(&ticket_of(&k.pool, &x.pubkey())).unwrap().data;
        assert!(raw[Ticket::space(2)..].iter().any(|b| *b != 0), "round 8 left the burned entries' bytes in the spare room");
    }
    go(env, 110, 100);
    buy_with_deposit(env, &w, &k, SOL / 2, 0);
    go(env, 113, 100);
    assert_eq!(ticket(env, &k.pool, &w.pubkey()).pending(), 2);
    go(env, 119, 100);
    load(env, &new);
    go(env, 121, 100);
    (m, k, w, v, sink)
}

#[test]
fn rev11_a_shrink_and_a_growth_in_one_transaction_end_like_two_transactions_with_no_stale_bytes() {
    let mut env = Env::new();
    let (_m, k, w, v, _sink) = two_round8_tickets_with_stale_room(&mut env);
    let fee = signature_fee(&mut env);
    let (wp, vp) = (w.pubkey(), v.pubkey());
    let mut keys = vec![ticket_of(&k.pool, &wp), ticket_of(&k.pool, &vp), cfg_of(&k.pool), collection_of(&k.pool)];
    keys.extend((0..6).map(|i| asset_of(&k.pool, &wp, i)));
    keys.extend((0..6).map(|i| asset_of(&k.pool, &vp, i)));
    let wallets = |env: &Env| env.lamports(&wp) + env.lamports(&vp);
    let start = env.svm.clone();
    let w_list = ticket(&env, &k.pool, &wp).owned.clone();
    // (what, the transactions of path one, of path two, whether path two signs once more)
    type Case<'a> = (&'a str, Vec<Vec<Instruction>>, Vec<Vec<Instruction>>, bool);
    let cases: Vec<Case> = vec![
        (
            "settle (shrinks W) then W's mint (grows it) vs W's mint alone",
            vec![vec![cb(800_000), settle_ix(&wp, &k, &wp, &[]), mint_ix(&wp, &k, 2, 4, 2)]],
            vec![vec![cb(800_000), mint_ix(&wp, &k, 2, 4, 2)]],
            false,
        ),
        (
            "settle then mint, one transaction vs two",
            vec![vec![cb(800_000), settle_ix(&wp, &k, &wp, &[]), mint_ix(&wp, &k, 2, 4, 2)]],
            vec![vec![cb(400_000), settle_ix(&wp, &k, &wp, &[])], vec![cb(400_000), mint_ix(&wp, &k, 2, 4, 2)]],
            true,
        ),
        (
            "withdraw (shrinks W) then mint, one transaction vs two",
            vec![vec![cb(800_000), withdraw_ix(&wp, &k.pool), mint_ix(&wp, &k, 2, 4, 2)]],
            vec![vec![withdraw_ix(&wp, &k.pool)], vec![cb(400_000), mint_ix(&wp, &k, 2, 4, 2)]],
            true,
        ),
        (
            "W sends one piece to V (W shrinks) then mints, one transaction vs two",
            vec![vec![cb(900_000), send_ix(&wp, &k, &vp, &[w_list[1]]), mint_ix(&wp, &k, 2, 4, 2)]],
            vec![vec![cb(400_000), send_ix(&wp, &k, &vp, &[w_list[1]])], vec![cb(400_000), mint_ix(&wp, &k, 2, 4, 2)]],
            true,
        ),
    ];
    for (what, one, two, extra_fee) in cases {
        env.svm = start.clone();
        let w0 = wallets(&env);
        for ixs in &one {
            env.ok(ixs, &[&w]);
        }
        let (snap_one, paid_one) = (snapshot(&env, &keys), w0 - wallets(&env));
        exact_bytes(&env, &k.pool, &wp, what);
        env.svm = start.clone();
        let w0 = wallets(&env);
        for ixs in &two {
            env.ok(ixs, &[&w]);
        }
        let (snap_two, paid_two) = (snapshot(&env, &keys), w0 - wallets(&env));
        same(&snap_one, &snap_two, what);
        assert_eq!(paid_two, paid_one + if extra_fee { fee } else { 0 }, "{what}: the wallet paid the same, a signature aside");
        assert_eq!(ticket_len(&env, &k.pool, &wp), Ticket::space(ticket(&env, &k.pool, &wp).owned.len()), "{what}");
        check_books(&env, &k, &[wp, vp], true, what);
    }

    // the receiver: V's settle shrinks V, W's send grows V again, in one transaction both sign
    env.svm = start.clone();
    let both = [cb(900_000), settle_ix(&vp, &k, &vp, &[]), send_ix(&wp, &k, &vp, &[w_list[1]])];
    let w0 = wallets(&env);
    env.ok(&both, &[&w, &v]);
    let (snap_one, paid_one) = (snapshot(&env, &keys), w0 - wallets(&env));
    exact_bytes(&env, &k.pool, &vp, "V shrunk and grown in one transaction");
    env.svm = start;
    let w0 = wallets(&env);
    env.ok(&[cb(400_000), settle_ix(&vp, &k, &vp, &[])], &[&v]);
    env.ok(&[cb(400_000), send_ix(&wp, &k, &vp, &[w_list[1]])], &[&w]);
    same(&snap_one, &snapshot(&env, &keys), "the receiver shrunk then grown");
    assert_eq!(w0 - wallets(&env), paid_one, "two signatures either way");
    assert_eq!(ticket_len(&env, &k.pool, &vp), Ticket::space(3));
    exact_bytes(&env, &k.pool, &vp, "V");
}

// =========================================================================================
// 4. The pegged coin: the transfer hook's own shrink-and-pay after a stranger's shrink
// =========================================================================================

#[test]
fn rev11_pegged_a_strangers_shrink_before_a_transfer_or_a_sell_counts_no_byte_twice() {
    // A pegged ticket round 7 grew for four pieces, holding two and one waiting. The transfer
    // hook pays the place a leaving piece takes (the receiver's ticket, the burn queue) out of the
    // rent the sender frees, against a floor of the sender's deposit at entry, then shrinks the
    // sender. If a stranger's settle shrinks the sender first, the spare rent is already deposit:
    // the pieces' own bytes still pay their place, and in the end the sender, the receiver, the
    // queue and the reaper hold exactly what they hold without the settle.
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r7);
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let fee = signature_fee(&mut env);
    let (f, g) = (peg_wallet(&mut env, &p), peg_wallet(&mut env, &p));
    let stranger = env.user(SOL);
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &f.pubkey(), &k, SOL)], &[&f]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&f.pubkey(), &k, 4, 0, 2)], &[&f]);
    go(&mut env, 119, 90);
    load(&mut env, &new);
    go(&mut env, 121, 90);
    env.ok(&[deposit_ix(&g.pubkey(), &k.pool, 777_777)], &[&g]);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    let watched = [ticket_of(&k.pool, &f.pubkey()), ticket_of(&k.pool, &g.pubkey()), queue_of(&k.pool)];
    let mut keys = watched.to_vec();
    keys.extend([cfg_of(&k.pool), f.pubkey(), g.pubkey()]);
    keys.extend((0..3).map(|i| asset_of(&k.pool, &f.pubkey(), i)));
    let start = env.svm.clone();

    // a forged execute (not inside a transfer) cannot move a lamport of F's ticket
    let forged = forged_execute_ix(&k, &coins_of(&k, &f.pubkey()), &coins_of(&k, &g.pubkey()), &watched[0], &watched[1], UNIT);
    refused(&mut env, &[forged], &[&stranger], &["NotATransfer"]);

    for sell in [false, true] {
        let mut ends = vec![];
        for settle_first in [false, true] {
            env.svm = start.clone();
            if settle_first {
                env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &f.pubkey(), &[])], &[&stranger]);
                assert_eq!((ticket_len(&env, &k.pool, &f.pubkey()), deposit(&env, &k.pool, &f.pubkey())), (Ticket::space(2), 2 * entry));
            }
            let sum0 = lamports_of(&env, &watched);
            let keep = coins(&env, &k, &f.pubkey()) - UNIT;
            if sell {
                // F sells down to one unit: its waiting piece is dropped, one minted piece burns into the queue
                let ix = peg_sell_ix(&env, &f.pubkey(), &k, keep);
                env.ok(&[cb(400_000), ix], &[&f]);
                assert_eq!(queue(&env, &k).len(), 1);
            } else {
                // F sends all but one unit to G: one minted piece moves to G
                env.ok(&[peg_transfer_ix(&k, &f.pubkey(), &g.pubkey(), keep)], &[&f]);
                assert_eq!(ticket(&env, &k.pool, &g.pubkey()).owned.len(), 1);
            }
            assert_eq!(lamports_of(&env, &watched), sum0, "sell {sell}, settle first {settle_first}: the transfer only moved rent between the tickets and the queue");
            assert_eq!(deposit(&env, &k.pool, &f.pubkey()), 2 * entry, "the two unused entries are F's deposit, once");
            assert_eq!(deposit(&env, &k.pool, &g.pubkey()), 777_777, "the receiver's deposit paid nothing");
            assert_eq!(ticket_len(&env, &k.pool, &f.pubkey()), Ticket::space(1));
            // the reaper's take, and F's withdraw
            let q = queue(&env, &k);
            let r0 = env.lamports(&stranger.pubkey());
            if !q.is_empty() {
                env.ok(&[cb(400_000), reap_ix(&stranger.pubkey(), &k, &q)], &[&stranger]);
            }
            let reaped = (env.lamports(&stranger.pubkey()) + if q.is_empty() { 0 } else { fee }) - r0;
            let f0 = env.lamports(&f.pubkey());
            env.ok(&[withdraw_ix(&f.pubkey(), &k.pool)], &[&f]);
            let withdrawn = env.lamports(&f.pubkey()) + fee - f0;
            assert_eq!(withdrawn, 2 * entry);
            check_books(&env, &k, &[f.pubkey(), g.pubkey()], false, "pegged");
            let mut s = snapshot(&env, &keys);
            // F paid one more signature on the path with the stranger's settle: nothing, as the stranger paid it
            s.retain(|x| x.0 != stranger.pubkey());
            ends.push((s, reaped));
        }
        assert_eq!(ends[0].1, ends[1].1, "sell {sell}: the reaper got the same");
        same(&ends[0].0, &ends[1].0, &format!("sell {sell}: with and without the stranger's shrink"));
    }
}

// =========================================================================================
// 5. Nobody but the wallet reaches the rent a shrink frees
// =========================================================================================

#[test]
fn rev11_nobody_but_the_wallet_reaches_the_rent_a_shrink_freed() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let other = newcomer(&mut env, &m);
    let stranger = env.user(SOL);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    buy_with_deposit(&mut env, &other, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    env.ok(&[cb(400_000), mint_ix(&other.pubkey(), &k, 3, 0, 3)], &[&other]);
    // W's coins leave by a plain transfer; a stranger's settle burns two pieces and shrinks
    let all = coins(&env, &k, &w.pubkey());
    env.ok(&[coin_transfer_ix(&k, &w.pubkey(), &other.pubkey(), all - UNIT)], &[&w]);
    let burn = newest_first(&env, &k, &w.pubkey());
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &burn)], &[&stranger]);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 2 * entry);
    let wt = ticket_of(&k.pool, &w.pubkey());
    let held = snapshot(&env, &[wt]);
    let not_signed = |mut ix: Instruction, at: usize| {
        ix.accounts[at].is_signer = false;
        ix
    };
    let named_ticket = |mut ix: Instruction, at: usize| {
        ix.accounts[at].pubkey = wt;
        ix
    };
    let attempts: Vec<(&str, Vec<Instruction>, &[&str])> = vec![
        ("withdraw by the stranger naming W's ticket", vec![named_ticket(withdraw_ix(&stranger.pubkey(), &k.pool), 1)], &["ConstraintSeeds"]),
        ("withdraw naming W without W's signature", vec![not_signed(withdraw_ix(&w.pubkey(), &k.pool), 0)], &["AccountNotSigner", "MissingRequiredSignature"]),
        ("withdraw by the other wallet naming W's ticket", vec![named_ticket(withdraw_ix(&stranger.pubkey(), &k.pool), 1)], &["ConstraintSeeds"]),
        ("mint by the stranger naming W's ticket", vec![cb(400_000), named_ticket(mint_ix(&stranger.pubkey(), &k, 1, 3, 1), 2)], &["ConstraintSeeds"]),
        ("mint naming W without W's signature", vec![cb(400_000), not_signed(mint_ix(&w.pubkey(), &k, 1, 3, 1), 0)], &["AccountNotSigner", "MissingRequiredSignature"]),
        ("send_pieces from W without W's signature", vec![cb(400_000), not_signed(send_ix(&w.pubkey(), &k, &stranger.pubkey(), &[burn[2]]), 0)], &["AccountNotSigner", "MissingRequiredSignature"]),
        ("reorder by the stranger naming W's ticket", vec![named_ticket(reorder_ix(&stranger.pubkey(), &k, 0, 0), 2)], &["ConstraintSeeds", "AccountNotInitialized"]),
        ("mint_for with nothing decided", vec![cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 3, 1)], &["NothingToMint"]),
        ("settle of W with the stranger's coins account", vec![cb(400_000), {
            let mut ix = settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[]);
            ix.accounts[3].pubkey = coins_of(&k, &other.pubkey());
            ix
        }], &["WrongCoins"]),
        ("a forged transfer hook call naming W's ticket", vec![forged_execute_ix(&k, &coins_of(&k, &w.pubkey()), &coins_of(&k, &stranger.pubkey()), &wt, &ticket_of(&k.pool, &stranger.pubkey()), UNIT)], &["NotATransfer", "ConstraintSeeds", "AccountNotInitialized"]),
    ];
    for (what, ixs, needles) in attempts {
        let s0 = env.lamports(&stranger.pubkey());
        refused(&mut env, &ixs, &[&stranger], needles);
        assert!(env.lamports(&stranger.pubkey()) <= s0, "{what}: the stranger gained");
        assert_eq!(snapshot(&env, &[wt]), held, "{what}: W's ticket changed");
    }
    // these land and change nothing of W's: opening W's ticket again, settling W again
    env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &k.pool, &w.pubkey())], &[&stranger]);
    env.ok(&[cb(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &burn)], &[&stranger]);
    assert_eq!(snapshot(&env, &[wt]), held, "a landed no-op changed W's ticket");
    // W alone takes it
    let w0 = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()) + fee - w0, 2 * entry);
    check_books(&env, &k, &[w.pubkey(), other.pubkey()], true, "nobody else");
}

// =========================================================================================
// 6. A random walk of mixed transactions with a lamport ledger
// =========================================================================================

#[derive(Clone, Copy, Debug, PartialEq)]
enum Act {
    Buy,
    BuyDeposit,
    Sell,
    SellSettle,
    OwnMint,
    Withdraw,
    Send,
    Reorder,
    CoinsAway,
    WithdrawThenMint,
    SettleThenMint,
    SendThenMint,
    SettleThenWithdraw,
    StrangerSettle,
    StrangerMintFor,
    StrangerSettleMintFor,
}

#[test]
fn rev11_a_walk_of_mixed_transactions_keeps_every_lamport_with_its_owner() {
    // Four wallets (two tickets round 7 left long) and a stranger. Each step is one transaction
    // of one to three instructions: a wallet's own (buys with or without deposit, sells, its own
    // settle, mints, withdraws, sends, reorders, coins away, and a shrink followed by a growth of
    // the same ticket), or the stranger's alone (settle anyone, mint_for anyone, or both). After
    // every step: no lamport appears or disappears beyond the fee; a stranger's transaction gives
    // it exactly the burned assets' lamports plus one KEEPER_FEE per mint_for, and the tickets
    // pay exactly the new assets plus those fees; a wallet's transaction leaves every other
    // wallet, ticket deposit and the stranger alone; every ticket is at least its rent and as long
    // as its list, and exactly as long after a shrink; every listed piece is in its holder's hands.
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r7);
    let (m, k) = plain_setup(&mut env, 5);
    let fee = signature_fee(&mut env);
    let wallets: Vec<Keypair> = (0..4).map(|_| newcomer(&mut env, &m)).collect();
    let keys: Vec<Pubkey> = wallets.iter().map(|w| w.pubkey()).collect();
    let stranger = env.user(50 * SOL);
    // round 7: W0 grown for four holding one, W1 for four holding two, W2 exactly as long
    r7_long_ticket(&mut env, &k, &wallets[0], SOL, 4, 1, 100);
    r7_long_ticket(&mut env, &k, &wallets[1], 2 * SOL, 60, 2, 110);
    r7_long_ticket(&mut env, &k, &wallets[2], SOL, 2, 2, 120);
    // round 8: W3 minted twelve and sold them; its ticket kept the twelve entries
    go(&mut env, 129, 120);
    load(&mut env, &r8);
    let slot0 = r8_sold_ticket(&mut env, &k, &wallets[3], 3, 131);
    go(&mut env, slot0 + 9, slot0 - 10);
    load(&mut env, &new);
    go(&mut env, slot0 + 11, slot0 - 10);
    assert_eq!(keys.iter().map(|u| ticket_len(&env, &k.pool, u)).collect::<Vec<_>>(), vec![Ticket::space(4), Ticket::space(4), Ticket::space(2), Ticket::space(12)]);

    let acts = [
        Act::Buy,
        Act::BuyDeposit,
        Act::Sell,
        Act::SellSettle,
        Act::OwnMint,
        Act::Withdraw,
        Act::Send,
        Act::Reorder,
        Act::CoinsAway,
        Act::WithdrawThenMint,
        Act::SettleThenMint,
        Act::SendThenMint,
        Act::SettleThenWithdraw,
        Act::StrangerSettle,
        Act::StrangerSettle,
        Act::StrangerMintFor,
        Act::StrangerMintFor,
        Act::StrangerMintFor,
        Act::StrangerSettleMintFor,
        Act::StrangerSettleMintFor,
    ];
    let mut seed = 0x9E3779B97F4A7C15u64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut slot = slot0 + 11;
    let mut counts = std::collections::BTreeMap::<String, (u32, u32)>::new();
    let (mut stranger_take, mut keeper_fees) = (0u64, 0u64);
    for step in 0..700 {
        slot += 1 + rnd() % 2;
        go(&mut env, slot, slot - 60);
        let i = (rnd() % 4) as usize;
        let j = (i + 1 + (rnd() % 3) as usize) % 4;
        let (w, to) = (&wallets[i], &wallets[j]);
        let wp = w.pubkey();
        let act = acts[(rnd() % acts.len() as u64) as usize];
        let has_ticket = exists(&env, &ticket_of(&k.pool, &wp));
        let t = if has_ticket { Some(ticket(&env, &k.pool, &wp)) } else { None };
        let have = coins(&env, &k, &wp);
        let mint_n = t.as_ref().map(|t| t.pending().min(4)).unwrap_or(0);
        let minted = t.as_ref().map(|t| t.minted).unwrap_or(0);
        let own_mint = mint_ix(&wp, &k, mint_n as u8, minted, mint_n);
        let burn6: Vec<Pubkey> = if has_ticket { newest_first(&env, &k, &wp).into_iter().take(6).collect() } else { vec![] };
        let pick: Vec<Pubkey> = t.as_ref().map(|t| t.owned.iter().rev().take(1 + (rnd() % 2) as usize).cloned().collect()).unwrap_or_default();
        let sp = stranger.pubkey();
        let by_stranger = matches!(act, Act::StrangerSettle | Act::StrangerMintFor | Act::StrangerSettleMintFor);
        let ixs: Vec<Instruction> = match act {
            Act::Buy | Act::BuyDeposit => {
                let mut v = vec![cb(400_000)];
                if !has_ticket {
                    v.push(open_ticket_ix(&wp, &k.pool));
                }
                v.push(buy_ix(&env, &wp, &k, SOL / 10 * (1 + rnd() % 8)));
                if act == Act::BuyDeposit {
                    v.push(deposit_ix(&wp, &k.pool, sdk_deposit_for(&env, &cfg(&env, &k.pool), 4 + 4 * (rnd() % 2) as u32)));
                }
                v
            }
            Act::Sell if have > 0 => vec![cb(600_000), sell_ix(&env, &wp, &k, if rnd() % 3 == 0 { have } else { (have / (2 + rnd() % 3)).max(1) })],
            Act::SellSettle if have > 0 && has_ticket => vec![cb(1_000_000), sell_ix(&env, &wp, &k, if rnd() % 3 == 0 { have } else { (have / (2 + rnd() % 3)).max(1) }), settle_ix(&wp, &k, &wp, &burn6)],
            Act::OwnMint if has_ticket => vec![cb(600_000), own_mint],
            Act::Withdraw if has_ticket => vec![withdraw_ix(&wp, &k.pool)],
            Act::Send if !pick.is_empty() => vec![cb(600_000), send_ix(&wp, &k, &to.pubkey(), &pick)],
            Act::Reorder if t.as_ref().map(|t| !t.owned.is_empty()).unwrap_or(false) => {
                let n = t.as_ref().unwrap().owned.len() as u64;
                vec![reorder_ix(&wp, &k, (rnd() % n) as u32, (rnd() % n) as u32)]
            }
            Act::CoinsAway if have > 0 => vec![coin_transfer_ix(&k, &wp, &to.pubkey(), have / (1 + rnd() % 3))],
            Act::WithdrawThenMint if has_ticket => vec![cb(800_000), withdraw_ix(&wp, &k.pool), own_mint],
            Act::SettleThenMint if has_ticket => vec![cb(1_200_000), settle_ix(&wp, &k, &wp, &burn6), own_mint],
            Act::SendThenMint if !pick.is_empty() => vec![cb(1_200_000), send_ix(&wp, &k, &to.pubkey(), &pick), own_mint],
            Act::SettleThenWithdraw if has_ticket => vec![cb(800_000), settle_ix(&wp, &k, &wp, &burn6), withdraw_ix(&wp, &k.pool)],
            Act::StrangerSettle if has_ticket => vec![cb(800_000), settle_ix(&sp, &k, &wp, &burn6)],
            Act::StrangerMintFor if has_ticket => vec![cb(600_000), mint_for_ix(&sp, &k, &wp, minted, mint_n.max(1))],
            Act::StrangerSettleMintFor if has_ticket => vec![cb(1_200_000), settle_ix(&sp, &k, &wp, &burn6), mint_for_ix(&sp, &k, &wp, minted, mint_n.max(1))],
            _ => continue,
        };
        let mint_fors = ixs.iter().filter(|x| x.program_id == pid() && x.data[..8] == hook_collectible::instruction::MintFor {}.data()[..8]).count() as u64;
        let shrinks_i = matches!(act, Act::SellSettle | Act::Withdraw | Act::Send | Act::WithdrawThenMint | Act::SettleThenMint | Act::SendThenMint | Act::SettleThenWithdraw | Act::StrangerSettle);

        // every account a lamport can reach in this step
        let mut tracked = vec![sp, cfg_of(&k.pool), collection_of(&k.pool)];
        let mut asset_keys = vec![];
        for u in &keys {
            tracked.push(*u);
            tracked.push(ticket_of(&k.pool, u));
            let mm = if exists(&env, &ticket_of(&k.pool, u)) { ticket(&env, &k.pool, u).minted } else { 0 };
            asset_keys.extend((0..mm + 4).map(|x| asset_of(&k.pool, u, x)));
        }
        tracked.extend(asset_keys.iter().cloned());
        let lam = |env: &Env| -> Vec<u64> { tracked.iter().map(|a| env.lamports(a)).collect() };
        let deps = |env: &Env| -> Vec<Option<u64>> {
            keys.iter().map(|u| env.svm.get_account(&ticket_of(&k.pool, u)).filter(|a| !a.data.is_empty()).map(|a| a.lamports - rent(env, a.data.len()))).collect()
        };
        let tickets_snap = |env: &Env| snapshot(env, &keys.iter().map(|u| ticket_of(&k.pool, u)).collect::<Vec<_>>());
        let (lb, db, tb) = (lam(&env), deps(&env), tickets_snap(&env));
        let signer: &Keypair = if by_stranger { &stranger } else { w };
        let ok = env.send(&ixs, &[signer]).is_ok();
        let (la, da, ta) = (lam(&env), deps(&env), tickets_snap(&env));
        let what = format!("step {step} {act:?} on wallet {i} (to {j}), ok {ok}");
        let c = counts.entry(format!("{act:?}")).or_insert((0, 0));
        if ok { c.0 += 1 } else { c.1 += 1 }

        let sum = |v: &[u64]| v.iter().map(|x| *x as u128).sum::<u128>();
        let gone = sum(&lb) - sum(&la);
        if !ok {
            assert!(gone == 0 || gone == fee as u128, "{what}: a refused transaction moved {gone}");
            assert_eq!(tb, ta, "{what}: a refused transaction changed a ticket");
            continue;
        }
        assert_eq!(gone, fee as u128, "{what}: lamports appeared or disappeared beyond the fee");
        let at = |key: &Pubkey| tracked.iter().position(|x| x == key).unwrap();
        let delta = |key: &Pubkey| la[at(key)] as i128 - lb[at(key)] as i128;
        let (mut burned_out, mut created) = (0i128, 0i128);
        for a in &asset_keys {
            let d = delta(a);
            if d < 0 { burned_out -= d } else { created += d }
        }
        let tickets_delta: i128 = keys.iter().map(|u| delta(&ticket_of(&k.pool, u))).sum();
        if by_stranger {
            assert_eq!(delta(&sp), burned_out + (mint_fors * KEEPER_FEE) as i128 - fee as i128, "{what}: the stranger's take is the burned assets plus one fee per mint_for");
            assert_eq!(tickets_delta, -(created + (mint_fors * KEEPER_FEE) as i128), "{what}: the tickets paid the new assets and the fees, nothing else");
            for u in &keys {
                assert_eq!(delta(u), 0, "{what}: a wallet's lamports moved in the stranger's transaction");
            }
            stranger_take += (burned_out as u64) + mint_fors * KEEPER_FEE;
            keeper_fees += mint_fors * KEEPER_FEE;
        } else {
            assert_eq!(delta(&sp), 0, "{what}: the stranger's lamports moved in a wallet's transaction");
            for (u, key) in keys.iter().enumerate() {
                if u == i {
                    continue;
                }
                assert_eq!(delta(key), 0, "{what}: another wallet paid");
                match (db[u], da[u]) {
                    (Some(b), Some(a)) => assert_eq!(a, b, "{what}: another wallet's deposit moved"),
                    (None, Some(a)) => assert_eq!(a, 0, "{what}: a ticket opened for another wallet holds a deposit"),
                    (None, None) => {}
                    (Some(_), None) => panic!("{what}: a ticket disappeared"),
                }
                assert!(la[at(&ticket_of(&k.pool, key))] >= lb[at(&ticket_of(&k.pool, key))], "{what}: another wallet's ticket lost lamports");
            }
        }
        if shrinks_i {
            assert_eq!(ticket_len(&env, &k.pool, &wp), Ticket::space(ticket(&env, &k.pool, &wp).owned.len()), "{what}: not exactly as long as its list");
        }
        check_books(&env, &k, &keys, true, &what);
    }
    println!("walk: (ok, refused) per kind {counts:?}; the stranger took {stranger_take} lamports, {keeper_fees} of them keeper fees");
    for kind in ["StrangerSettle", "StrangerMintFor", "StrangerSettleMintFor", "SettleThenMint", "WithdrawThenMint", "SendThenMint", "SettleThenWithdraw", "SellSettle", "Send", "Withdraw"] {
        assert!(counts.get(kind).map(|c| c.0).unwrap_or(0) > 0, "the walk ran a {kind} that landed");
    }
    // every wallet takes what is left; every ticket ends exactly at its rent and its list
    for w in &wallets {
        if exists(&env, &ticket_of(&k.pool, &w.pubkey())) && env.send(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]).is_ok() {
            assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 0);
        }
        if exists(&env, &ticket_of(&k.pool, &w.pubkey())) {
            let t = ticket(&env, &k.pool, &w.pubkey());
            assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), Ticket::space(t.owned.len()));
            assert_eq!(env.lamports(&ticket_of(&k.pool, &w.pubkey())), rent(&env, Ticket::space(t.owned.len())));
        }
    }
}

// =========================================================================================
// 7. Compute and size: within a hair of the live binary; a list at its cap
// =========================================================================================

#[test]
fn rev11_settle_send_and_withdraw_cost_what_they_cost_under_the_live_binary_plus_the_resize() {
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 4);
    let (w, v, x) = (newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m));
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    buy_with_deposit(&mut env, &v, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&w.pubkey(), &k, 4, 0, 4)], &[&w]);
    env.ok(&[cb(400_000), mint_ix(&v.pubkey(), &k, 4, 0, 4)], &[&v]);
    env.ok(&[deposit_ix(&x.pubkey(), &k.pool, 1), open_ticket_ix(&x.pubkey(), &k.pool)], &[&x]);
    env.ok(&[cb(600_000), sell_all_ix(&env, &w.pubkey(), &k)], &[&w]);
    go(&mut env, 109, 90);
    let start = env.svm.clone();
    let wb = newest_first(&env, &k, &w.pubkey());
    let vl = ticket(&env, &k.pool, &v.pubkey()).owned.clone();
    let ops: Vec<(&str, Vec<Instruction>, &Keypair)> = vec![
        ("settle burning 1", vec![cb(400_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &wb[..1])], &w),
        ("settle burning 4", vec![cb(800_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &wb)], &w),
        ("send_pieces of 2", vec![cb(400_000), send_ix(&v.pubkey(), &k, &x.pubkey(), &vl[2..])], &v),
        ("send_pieces of 4", vec![cb(800_000), send_ix(&v.pubkey(), &k, &x.pubkey(), &vl)], &v),
    ];
    for (what, ixs, signer) in ops {
        let mut cu = vec![];
        for bin in [&r8, &new] {
            env.svm = start.clone();
            load(&mut env, bin);
            go(&mut env, 111, 90);
            cu.push(env.ok(&ixs, &[signer]).compute_units_consumed);
        }
        println!("{what}: live binary {} CU, round 11 {} CU, transaction {} bytes either way", cu[0], cu[1], env.tx_size(&ixs, &signer.pubkey(), 1));
        assert!(cu[1] <= cu[0] + 1_500, "{what}: the shrink costs more than 1,500 CU");
    }
    // withdraw after a settle the live binary made: it refuses (no deposit at the current
    // length); this one shrinks and pays
    env.svm = start.clone();
    load(&mut env, &r8);
    go(&mut env, 111, 90);
    env.ok(&[cb(800_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &wb)], &[&w]);
    go(&mut env, 113, 90);
    let after_settle = env.svm.clone();
    refused(&mut env, &[withdraw_ix(&w.pubkey(), &k.pool)], &[&w], &["NoDeposit"]);
    env.svm = after_settle;
    load(&mut env, &new);
    go(&mut env, 115, 90);
    let cu = env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]).compute_units_consumed;
    println!("withdraw_deposit of a ticket the live binary left four entries long: {cu} CU");
    assert!(cu < 20_000);
    assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), Ticket::space(0));

    // a list at its cap, in a ticket longer than its list: settle and withdraw stay small
    env.svm = start;
    load(&mut env, &new);
    go(&mut env, 111, 90);
    let key = ticket_of(&k.pool, &x.pubkey());
    let mut t = ticket(&env, &k.pool, &x.pubkey());
    t.owned = (0..hook_collectible::MAX_PIECES_PER_WALLET).map(|_| Pubkey::new_unique()).collect();
    let mut data = Vec::new();
    t.try_serialize(&mut data).unwrap();
    data.resize(data.len() + 32 * 100, 0);
    let mut acc = env.svm.get_account(&key).unwrap();
    acc.lamports = rent(&env, data.len());
    acc.data = data;
    env.svm.set_account(key, acc).unwrap();
    let cu = env.ok(&[cb(400_000), settle_ix(&w.pubkey(), &k, &x.pubkey(), &[])], &[&w]).compute_units_consumed;
    assert_eq!(ticket_len(&env, &k.pool, &x.pubkey()), Ticket::space(200));
    assert_eq!(deposit(&env, &k.pool, &x.pubkey()), rent(&env, Ticket::space(300)) - rent(&env, Ticket::space(200)));
    let cu2 = env.ok(&[withdraw_ix(&x.pubkey(), &k.pool)], &[&x]).compute_units_consumed;
    println!("a list of 200 in a ticket 100 entries longer: settle {cu} CU, withdraw {cu2} CU");
    assert!(cu < 200_000 && cu2 < 200_000);
}

// =========================================================================================
// 8. A rollback to the live binary keeps what a shrink freed withdrawable
// =========================================================================================

#[test]
fn rev11_after_a_rollback_to_the_live_binary_the_freed_rent_is_still_the_wallets() {
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    env.ok(&[cb(600_000), sell_all_ix(&env, &w.pubkey(), &k)], &[&w]);
    let burn = newest_first(&env, &k, &w.pubkey());
    env.ok(&[cb(600_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &burn)], &[&w]);
    assert_eq!((ticket_len(&env, &k.pool, &w.pubkey()), deposit(&env, &k.pool, &w.pubkey())), (Ticket::space(0), 3 * entry));
    go(&mut env, 109, 90);
    load(&mut env, &r8);
    go(&mut env, 111, 90);
    let w0 = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()) + fee - w0, 3 * entry, "the live binary pays a shrunk ticket's deposit too");
    check_books(&env, &k, &[w.pubkey()], true, "after a rollback");
}

// =========================================================================================
// 9. The SDK's withdraw offer for a ticket an older binary left long
// =========================================================================================

#[test]
fn finding_l1_a_withdraw_offer_read_at_the_tickets_current_length_misses_what_the_program_pays() {
    // FINDING L1 (low, SDK; confirmed). `collectibleWithdrawInstructions` (sdk/src/client.ts)
    // offered a withdraw when `ticketDeposit` > 0, and `ticketDeposit` was `depositOf(lamports,
    // dataLength)`: the deposit at the ticket's CURRENT length. A ticket round 7 left long (or one
    // round 8 never shrank after a settle or a send) has 0 there, so no withdraw is offered,
    // while `withdraw_deposit` now shrinks first and pays the spare entries. The exact figure is
    // `lamports - rent(min(dataLength, ticketSpace(owned)))`. Under the live round-8 binary that
    // same figure is NOT payable (no shrink: NoDeposit), so the SDK change must ship after the
    // program upgrade, not before. A mint (`mint`, `mint_for`, a keeper's cost check, a buy's
    // top-up) must keep reading the deposit at the current length: none of them shrinks.
    let r7 = live_binary(LIVE_R7_SO, LIVE_R7_SHA256);
    let r8 = live_binary(LIVE_R8_SO, LIVE_R8_SHA256);
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &r7);
    let (m, k) = plain_setup(&mut env, 5);
    let fee = signature_fee(&mut env);
    let (a, b, c) = (newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m));
    // round 7: A grown for four holding two, B asked for nine (round 7 grew for at most four) holding one
    r7_long_ticket(&mut env, &k, &a, SOL, 4, 2, 100);
    r7_long_ticket(&mut env, &k, &b, SOL, 9, 1, 110);
    assert_eq!(ticket_len(&env, &k.pool, &b.pubkey()), Ticket::space(4), "round 7 grew a ticket for at most four more pieces");
    // round 8, live now: C minted eight and sold them; its ticket kept the eight entries
    go(&mut env, 119, 90);
    load(&mut env, &r8);
    let slot = r8_sold_ticket(&mut env, &k, &c, 2, 121);
    go(&mut env, slot + 9, slot - 10);
    let before_upgrade = env.svm.clone();
    let sdk_old = |env: &Env, u: &Pubkey| deposit(env, &k.pool, u);
    let sdk_fixed = |env: &Env, u: &Pubkey| {
        let acc = env.svm.get_account(&ticket_of(&k.pool, u)).unwrap();
        let owned = ticket(env, &k.pool, u).owned.len();
        acc.lamports.saturating_sub(rent(env, acc.data.len().min(Ticket::space(owned))))
    };
    load(&mut env, &new);
    go(&mut env, slot + 11, slot - 10);
    for (w, spare) in [(&a, 2u64), (&b, 3), (&c, 8)] {
        let entry = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));
        let (old, fixed) = (sdk_old(&env, &w.pubkey()), sdk_fixed(&env, &w.pubkey()));
        let w0 = env.lamports(&w.pubkey());
        env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
        let paid = env.lamports(&w.pubkey()) + fee - w0;
        println!("FINDING L1: the old offer reads {old}, the program pays {paid}, min(length, list) reads {fixed}");
        assert_eq!((old, paid, fixed), (0, spare * entry, spare * entry));
    }
    // under the live binary the fixed figure is not payable yet
    env.svm = before_upgrade;
    go(&mut env, slot + 11, slot - 10);
    for w in [&a, &b, &c] {
        assert!(sdk_fixed(&env, &w.pubkey()) > 0);
        refused(&mut env, &[withdraw_ix(&w.pubkey(), &k.pool)], &[w], &["NoDeposit"]);
    }
}
