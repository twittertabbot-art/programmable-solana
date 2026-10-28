//! Collectible template. The pieces a buy earns are decided by a block that does not
//! exist yet when the buy is made, so nobody can predict, grind or re-roll them. And the
//! pieces are pegged to the coin: a wallet holds at most one per `unit` coins, a sell
//! burns from the end of the wallet's list, a piece moves only with its coins.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use hook_collectible::{Batch, BATCH_EMPTY, BATCH_EXPIRED, BATCH_REVEALED, BATCH_WAITING, SLOT_HASHES_ID};
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
/// 2,000 coins per piece: a 1 SOL buy (about 9,870 coins) earns 4.
const UNIT: u64 = 2_000 * 1_000_000;
const ART_A: [u8; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ART_B: [u8; 16] = [0xAA; 16];

fn pid() -> Pubkey {
    hook_collectible::ID
}
fn cfg_of(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[hook_collectible::CFG_SEED, pool.as_ref()], &pid()).0
}
fn collection_of(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[hook_collectible::COLLECTION_SEED, pool.as_ref()], &pid()).0
}
fn authority_of(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[hook_collectible::AUTHORITY_SEED, pool.as_ref()], &pid()).0
}
fn ticket_of(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[hook_collectible::TICKET_SEED, pool.as_ref(), user.as_ref()], &pid()).0
}
fn asset_of(pool: &Pubkey, user: &Pubkey, index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[hook_collectible::ASSET_SEED, pool.as_ref(), user.as_ref(), &index.to_le_bytes()],
        &pid(),
    )
    .0
}
/// The hook as seen by `user`: config, that user's ticket, and the SlotHashes sysvar.
fn hook_for(pool: &Pubkey, user: &Pubkey) -> HookRef {
    HookRef {
        program: pid(),
        treasury: system_program::ID,
        extra: vec![
            AccountMeta::new(cfg_of(pool), false),
            AccountMeta::new(ticket_of(pool, user), false),
            AccountMeta::new_readonly(SLOT_HASHES_ID, false),
        ],
    }
}
fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The block hash the tests give to a slot.
fn block_hash(slot: u64) -> [u8; 32] {
    hashv(&[b"block", &slot.to_le_bytes()]).to_bytes()
}
/// Move the chain to `slot`. SlotHashes then holds every slot in `from..slot` except the
/// ones listed as skipped, like the real sysvar (the current slot is never in it).
fn go(env: &mut Env, slot: u64, from: u64, skipped: &[u64]) {
    env.svm.warp_to_slot(slot);
    let v: Vec<(u64, Hash)> = (from..slot)
        .filter(|s| !skipped.contains(s))
        .map(|s| (s, Hash::new_from_array(block_hash(s))))
        .collect();
    env.svm.set_sysvar(&SlotHashes::new(&v));
}

/// What the program must derive for a batch decided by `hash_slot`'s block.
fn expected_batch_seed(pool: &Pubkey, user: &Pubkey, target: u64, hash_slot: u64, first_roll: u32) -> [u8; 32] {
    hashv(&[&block_hash(hash_slot), pool.as_ref(), user.as_ref(), &target.to_le_bytes(), &first_roll.to_le_bytes()]).to_bytes()
}
fn expected_piece(seed: [u8; 32], roll: u32) -> String {
    let b = Batch { state: BATCH_REVEALED, pieces: 1, minted_from: 0, first_roll: 0, target_slot: 0, seed, art: [0; 16] };
    hexs(&hook_collectible::piece_seed(&b, roll))
}

fn init_config_ix(payer: &Pubkey, owner: &Pubkey, pool: &Pubkey, max_supply: u32, max_per_buy: u8) -> Instruction {
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
            args: hook_collectible::InitCollectionArgs {
                name: "Shots".into(),
                uri_base: "https://example.com/art".into(),
                unit: UNIT,
                max_supply,
                max_per_buy,
                art: ART_A,
            },
        }
        .data(),
    }
}

fn open_ticket_ix(user: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OpenTicket { user: *user, ticket: ticket_of(pool, user), system_program: system_program::ID }
            .to_account_metas(None),
        data: hook_collectible::instruction::OpenTicket { pool: *pool }.data(),
    }
}

fn reveal_ix(payer: &Pubkey, pool: &Pubkey, user: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::Reveal { payer: *payer, ticket: ticket_of(pool, user), slot_hashes: SLOT_HASHES_ID }
            .to_account_metas(None),
        data: hook_collectible::instruction::Reveal {}.data(),
    }
}

fn mint_ix(user: &Pubkey, k: &PoolKeys, count: u8, first_index: u32, n_accounts: u32) -> Instruction {
    let pool = &k.pool;
    let mut accounts = hook_collectible::accounts::MintPieces {
        user: *user,
        cfg: cfg_of(pool),
        ticket: ticket_of(pool, user),
        coins: ata(user, &k.base_mint),
        collection: collection_of(pool),
        collection_authority: authority_of(pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
        slot_hashes: SLOT_HASHES_ID,
    }
    .to_account_metas(None);
    for i in 0..n_accounts {
        accounts.push(AccountMeta::new(asset_of(pool, user, first_index + i), false));
    }
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Mint { count }.data() }
}

/// Market + config + pool, at slot 50. The collection owner is a separate dev wallet.
fn setup(env: &mut Env, max_supply: u32, max_per_buy: u8) -> (Market, PoolKeys, Keypair) {
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let dev = env.user(SOL);
    go(env, 50, 40, &[]);
    let ix = init_config_ix(&m.creator.pubkey(), &dev.pubkey(), &k.pool, max_supply, max_per_buy);
    env.ok(&[compute_budget_ix(300_000), ix], &[&m.creator, &dev]);
    let hook = hook_for(&k.pool, &m.creator.pubkey());
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    (m, k, dev)
}

fn cfg(env: &Env, pool: &Pubkey) -> hook_collectible::CollectionConfig {
    env.account(&cfg_of(pool))
}
fn ticket(env: &Env, pool: &Pubkey, user: &Pubkey) -> hook_collectible::Ticket {
    env.account(&ticket_of(pool, user))
}
fn asset_text(env: &Env, key: &Pubkey) -> String {
    String::from_utf8_lossy(&env.svm.get_account(key).expect("asset exists").data).to_string()
}
/// The 32 hex chars of the seed inside an asset's URI.
fn asset_seed_hex(env: &Env, key: &Pubkey, art: &[u8; 16]) -> String {
    let text = asset_text(env, key);
    let marker = format!("/p/{}/", hexs(art));
    let at = text.find(&marker).expect("uri carries the art parameters");
    text[at + marker.len()..at + marker.len() + 32].to_string()
}
fn buy(env: &mut Env, user: &Keypair, k: &PoolKeys, amount: u64) {
    let hook = hook_for(&k.pool, &user.pubkey());
    env.swap(user, k, &hook, DIRECTION_BUY, amount, 0).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
}

#[test]
fn a_buy_decides_nothing_the_future_block_does() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_flags, hook_collectible::FLAGS);
    assert_eq!(pool.hook_flags & CALL_ON_SELL, 0, "never called on sells");
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);

    // slot 100: the buy earns 3 pieces (4 units, capped at 3) and records only a target
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    let tk = ticket(&env, &k.pool, &t.pubkey());
    assert_eq!(tk.pending(), 3);
    let b = tk.batches[0];
    assert_eq!((b.state, b.pieces, b.target_slot, b.first_roll), (BATCH_WAITING, 3, 102, 0));
    assert_eq!(b.seed, [0u8; 32], "no seed exists at buy time: nothing to simulate");
    assert_eq!(cfg(&env, &k.pool).reserved_pending, 3);

    // minting in the buy's slot, or before the target block exists, mints nothing
    for slot in [100u64, 101, 102] {
        go(&mut env, slot, 90, &[]);
        env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 0, 3)], &[t]);
        assert_eq!(cfg(&env, &k.pool).minted, 0, "slot {slot}: block 102 is not known yet");
        assert_eq!(ticket(&env, &k.pool, &t.pubkey()).batches[0].state, BATCH_WAITING);
    }

    // slot 103: block 102 exists, the mint reveals and mints
    go(&mut env, 103, 90, &[]);
    let meta = env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 0, 3)], &[t]);
    println!("reveal + mint of 3 pieces used {} CU", meta.compute_units_consumed);
    let c = cfg(&env, &k.pool);
    assert_eq!((c.minted, c.reserved_pending), (3, 0));
    let tk = ticket(&env, &k.pool, &t.pubkey());
    assert_eq!((tk.pending(), tk.minted, tk.rolls), (0, 3, 3));
    assert_eq!(tk.owned, (0..3).map(|i| asset_of(&k.pool, &t.pubkey(), i)).collect::<Vec<_>>(), "the wallet's list, in mint order");
    assert_eq!(cfg(&env, &k.pool).live, 3);
    assert_eq!(tk.batches[0].state, BATCH_EMPTY, "batch freed once fully minted");

    // every piece is exactly what block 102's hash dictates, and they all differ
    let seed = expected_batch_seed(&k.pool, &t.pubkey(), 102, 102, 0);
    let mut seen = std::collections::HashSet::new();
    for i in 0..3u32 {
        let key = asset_of(&k.pool, &t.pubkey(), i);
        let a = env.svm.get_account(&key).unwrap();
        assert_eq!(a.owner, MPL_CORE);
        assert_eq!(a.data[0], 1, "Key::AssetV1");
        assert_eq!(&a.data[1..33], t.pubkey().as_ref(), "owned by the buyer");
        assert!(asset_text(&env, &key).contains(&format!("Shots #{}", i + 1)));
        let got = asset_seed_hex(&env, &key, &ART_A);
        assert_eq!(got, expected_piece(seed, i), "piece {i} comes from the block hash");
        seen.insert(got);
    }
    assert_eq!(seen.len(), 3);
    // a different block hash would have given different pieces
    let other = hashv(&[&[7u8; 32], k.pool.as_ref(), t.pubkey().as_ref(), &102u64.to_le_bytes(), &0u32.to_le_bytes()]).to_bytes();
    assert_ne!(expected_piece(other, 0), expected_piece(seed, 0));
}

#[test]
fn a_skipped_target_slot_uses_the_next_block() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 1);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    // slots 102 and 103 produced no block; 104 did
    go(&mut env, 106, 90, &[102, 103]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 1, 0, 1)], &[t]);
    let seed = expected_batch_seed(&k.pool, &t.pubkey(), 102, 104, 0);
    assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &t.pubkey(), 0), &ART_A), expected_piece(seed, 0));
}

#[test]
fn nothing_done_after_the_buy_can_change_a_piece() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 2);
    let a = &m.trader;
    let b = env.user(5 * SOL);
    env.fund(&b, &m.authority, &m.base_mint, &m.quote_mint, 0, 20 * SOL);
    env.ok(&[open_ticket_ix(&a.pubkey(), &k.pool)], &[a]);
    env.ok(&[open_ticket_ix(&b.pubkey(), &k.pool)], &[&b]);

    go(&mut env, 100, 90, &[]);
    buy(&mut env, a, &k, SOL); // A: rolls 0 and 1, target 102
    buy(&mut env, &b, &k, SOL); // B: rolls 0 and 1, target 102
    let seed_a = expected_batch_seed(&k.pool, &a.pubkey(), 102, 102, 0);

    // a stranger reveals A's ticket: the seed is now fixed on chain
    go(&mut env, 103, 90, &[]);
    let stranger = env.user(SOL);
    env.ok(&[reveal_ix(&stranger.pubkey(), &k.pool, &a.pubkey())], &[&stranger]);
    let tk = ticket(&env, &k.pool, &a.pubkey());
    assert_eq!((tk.batches[0].state, tk.batches[0].seed), (BATCH_REVEALED, seed_a));

    // B mints first, moving the global counter; much later, with the block long gone
    // from the sysvar, A mints one piece, then the other in another transaction
    env.ok(&[compute_budget_ix(400_000), mint_ix(&b.pubkey(), &k, 2, 0, 2)], &[&b]);
    go(&mut env, 5_000, 4_900, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&a.pubkey(), &k, 1, 0, 1)], &[a]);
    go(&mut env, 9_000, 8_900, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&a.pubkey(), &k, 1, 1, 1)], &[a]);

    // A's pieces are exactly rolls 0 and 1 of the revealed seed, whatever happened between
    assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &a.pubkey(), 0), &ART_A), expected_piece(seed_a, 0));
    assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &a.pubkey(), 1), &ART_A), expected_piece(seed_a, 1));
    // the numbers in the names only reflect mint order
    assert!(asset_text(&env, &asset_of(&k.pool, &a.pubkey(), 0)).contains("Shots #3"));
    assert!(asset_text(&env, &asset_of(&k.pool, &b.pubkey(), 0)).contains("Shots #1"));
    // revealing again changes nothing
    env.ok(&[reveal_ix(&stranger.pubkey(), &k.pool, &b.pubkey())], &[&stranger]);
}

#[test]
fn an_unrevealed_batch_expires_to_common_never_to_a_fresh_roll() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);

    // nobody reveals for 1,000 slots: block 102 is no longer in the sysvar (512 slots)
    go(&mut env, 1_100, 600, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 0, 3)], &[t]);
    assert_eq!(cfg(&env, &k.pool).minted, 3, "expired pieces still exist and still use supply");
    for i in 0..3u32 {
        let seed_hex = asset_seed_hex(&env, &asset_of(&k.pool, &t.pubkey(), i), &ART_A);
        assert_eq!(&seed_hex[18..20], "ff", "rarity byte forced to the common tier");
    }
    // and the expiry seed owes nothing to any later block: it is the fixed fallback
    let fallback = hashv(&[b"expired", k.pool.as_ref(), t.pubkey().as_ref(), &102u64.to_le_bytes(), &0u32.to_le_bytes()]).to_bytes();
    let b = Batch { state: BATCH_EXPIRED, pieces: 1, minted_from: 0, first_roll: 0, target_slot: 102, seed: fallback, art: [0; 16] };
    assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &t.pubkey(), 0), &ART_A), hexs(&hook_collectible::piece_seed(&b, 0)));
}

#[test]
fn a_later_buy_cannot_reroll_a_batch_whose_block_has_passed() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 2);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL); // batch 0: rolls 0..2, target 102

    // slot 105: the holder knows block 102 by now. They buy again hoping to move it.
    go(&mut env, 105, 90, &[]);
    buy(&mut env, t, &k, SOL);
    let tk = ticket(&env, &k.pool, &t.pubkey());
    let seed0 = expected_batch_seed(&k.pool, &t.pubkey(), 102, 102, 0);
    assert_eq!((tk.batches[0].state, tk.batches[0].seed, tk.batches[0].pieces), (BATCH_REVEALED, seed0, 2), "locked in by the second buy itself");
    assert_eq!((tk.batches[1].state, tk.batches[1].target_slot, tk.batches[1].first_roll, tk.batches[1].pieces), (BATCH_WAITING, 107, 2, 2), "new pieces went to a new batch");

    go(&mut env, 108, 90, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 0, 4)], &[t]);
    let seed1 = expected_batch_seed(&k.pool, &t.pubkey(), 107, 107, 2);
    let got: Vec<String> = (0..4).map(|i| asset_seed_hex(&env, &asset_of(&k.pool, &t.pubkey(), i), &ART_A)).collect();
    assert_eq!(got, vec![expected_piece(seed0, 0), expected_piece(seed0, 1), expected_piece(seed1, 2), expected_piece(seed1, 3)]);
}

#[test]
fn buys_before_the_block_merge_and_a_full_ticket_earns_nothing() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 1);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);

    // two buys before block 102 exists share one batch and keep the earlier target
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    go(&mut env, 101, 90, &[]);
    buy(&mut env, t, &k, SOL);
    let tk = ticket(&env, &k.pool, &t.pubkey());
    assert_eq!((tk.batches[0].pieces, tk.batches[0].target_slot, tk.rolls), (2, 102, 2));
    assert_eq!(tk.batches[1].state, BATCH_EMPTY);

    // three more buys, each after the previous block passed: four batches, all held
    for (i, slot) in [110u64, 120, 130].iter().enumerate() {
        go(&mut env, *slot, 90, &[]);
        buy(&mut env, t, &k, SOL);
        let tk = ticket(&env, &k.pool, &t.pubkey());
        assert_eq!(tk.batches[i + 1].target_slot, slot + 2);
    }
    let before = cfg(&env, &k.pool).reserved_pending;
    assert_eq!(before, 5);

    // a fifth batch has nowhere to go: the buy still works, and earns nothing
    go(&mut env, 140, 90, &[]);
    buy(&mut env, t, &k, SOL);
    assert_eq!(cfg(&env, &k.pool).reserved_pending, before);
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).rolls, 5);

    // minting frees the batches and earning resumes
    go(&mut env, 141, 90, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 0, 4)], &[t]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 4, 1)], &[t]);
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).pending(), 0);
    go(&mut env, 150, 90, &[]);
    buy(&mut env, t, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).pending(), 1);
}

#[test]
fn no_ticket_means_no_piece_and_the_trade_still_goes_through() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let t = &m.trader;
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    assert_eq!(cfg(&env, &k.pool).reserved_pending, 0);
    assert!(env.svm.get_account(&ticket_of(&k.pool, &t.pubkey())).map(|a| a.data.is_empty()).unwrap_or(true));
    // sells are never seen by the hook
    let hook = hook_for(&k.pool, &t.pubkey());
    env.swap(t, &k, &hook, DIRECTION_SELL, 1_000_000_000, 0).unwrap();
    // a buy below one unit earns nothing even with a ticket
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    buy(&mut env, t, &k, SOL / 100);
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).pending(), 0);
}

#[test]
fn supply_is_capped_and_fixed() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 2, 3);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).pending(), 2, "only two exist");
    // a second buyer gets nothing: both are reserved
    let other = env.user(5 * SOL);
    env.fund(&other, &m.authority, &m.base_mint, &m.quote_mint, 0, 10 * SOL);
    env.ok(&[open_ticket_ix(&other.pubkey(), &k.pool)], &[&other]);
    buy(&mut env, &other, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &other.pubkey()).pending(), 0);
    go(&mut env, 103, 90, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 4, 0, 2)], &[t]);
    let c = cfg(&env, &k.pool);
    assert_eq!((c.minted, c.max_supply, c.reserved_pending), (2, 2, 0));
    buy(&mut env, t, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).pending(), 0, "sold out");
}

#[test]
fn owner_updates_change_future_pieces_only_and_the_lock_is_final() {
    let mut env = Env::new();
    let (m, k, dev) = setup(&mut env, 1_000, 1);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    go(&mut env, 103, 90, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 1, 0, 1)], &[t]);
    let first = asset_of(&k.pool, &t.pubkey(), 0);
    let before = env.svm.get_account(&first).unwrap().data;

    let update = |owner: &Pubkey, args: hook_collectible::UpdateCollectionArgs| Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::UpdateCollection {
            owner: *owner,
            cfg: cfg_of(&k.pool),
            collection: collection_of(&k.pool),
            collection_authority: authority_of(&k.pool),
            core_program: MPL_CORE,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::UpdateCollection { args }.data(),
    };
    let stranger = env.user(SOL);
    env.err(
        &[update(&stranger.pubkey(), hook_collectible::UpdateCollectionArgs { name: None, uri_base: None, art: Some(ART_B) })],
        &[&stranger],
        "only the collection owner",
    );
    env.ok(
        &[update(&dev.pubkey(), hook_collectible::UpdateCollectionArgs { name: Some("Shots II".into()), uri_base: None, art: Some(ART_B) })],
        &[&dev],
    );
    let c = cfg(&env, &k.pool);
    assert_eq!((c.name.as_str(), c.art, c.art_version), ("Shots II", ART_B, 2));
    assert!(asset_text(&env, &c.collection).contains("Shots II"), "core collection renamed");

    // the piece minted before the update is byte-for-byte unchanged
    assert_eq!(env.svm.get_account(&first).unwrap().data, before);
    assert!(String::from_utf8_lossy(&before).contains(&hexs(&ART_A)));

    // the next piece carries the new art and the new name
    go(&mut env, 110, 90, &[]);
    buy(&mut env, t, &k, SOL);
    go(&mut env, 113, 90, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &k, 1, 1, 1)], &[t]);
    let second = asset_text(&env, &asset_of(&k.pool, &t.pubkey(), 1));
    assert!(second.contains(&hexs(&ART_B)) && second.contains("Shots II #2"), "{second}");

    let lock = Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OwnerOnly { owner: dev.pubkey(), cfg: cfg_of(&k.pool) }.to_account_metas(None),
        data: hook_collectible::instruction::SetOwner { new_owner: Pubkey::default() }.data(),
    };
    env.ok(&[lock], &[&dev]);
    env.err(
        &[update(&dev.pubkey(), hook_collectible::UpdateCollectionArgs { name: None, uri_base: None, art: Some(ART_A) })],
        &[&dev],
        "locked",
    );
    let c = cfg(&env, &k.pool);
    assert_eq!((c.unit, c.max_supply, c.max_per_buy), (UNIT, 1_000, 1));
}

#[test]
fn config_must_be_paid_by_the_pool_creator_and_limits_hold() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let stranger = env.user(SOL);
    go(&mut env, 50, 40, &[]);
    let bad = init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, 100, 6);
    env.err(&[compute_budget_ix(300_000), bad], &[&m.creator], "between 1 and 5");
    let bad = init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, 0, 1);
    env.err(&[compute_budget_ix(300_000), bad], &[&m.creator], "max supply");
    let ix = init_config_ix(&stranger.pubkey(), &stranger.pubkey(), &k.pool, 100, 1);
    env.ok(&[compute_budget_ix(300_000), ix], &[&stranger]);
    let hook = hook_for(&k.pool, &m.creator.pubkey());
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "not created by the pool creator");
}

#[test]
fn nobody_can_mint_from_another_wallets_ticket_or_into_a_wrong_asset_address() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 2);
    let t = &m.trader;
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    go(&mut env, 103, 90, &[]);
    let thief = env.user(SOL);
    let mut ix = mint_ix(&thief.pubkey(), &k, 2, 0, 1);
    ix.accounts[2].pubkey = ticket_of(&k.pool, &t.pubkey());
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&thief]).is_err());
    let mut ix = mint_ix(&t.pubkey(), &k, 1, 0, 1);
    let last = ix.accounts.len() - 1;
    ix.accounts[last].pubkey = asset_of(&k.pool, &t.pubkey(), 7);
    env.err(&[compute_budget_ix(400_000), ix], &[t], "not the expected address");
    assert_eq!(ticket(&env, &k.pool, &t.pubkey()).pending(), 2, "nothing was lost");
}

// ---- the peg: one piece per unit of coins held ---------------------------------------------

fn settle_ix(payer: &Pubkey, k: &PoolKeys, user: &Pubkey, assets: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::Settle {
        payer: *payer,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        coins: ata(user, &k.base_mint),
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for a in assets {
        accounts.push(AccountMeta::new(*a, false));
    }
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Settle {}.data() }
}

fn reorder_ix(user: &Pubkey, k: &PoolKeys, from: u32, to: u32) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::Reorder { user: *user, cfg: cfg_of(&k.pool), ticket: ticket_of(&k.pool, user), coins: ata(user, &k.base_mint) }
            .to_account_metas(None),
        data: hook_collectible::instruction::Reorder { from, to }.data(),
    }
}

fn send_ix(user: &Pubkey, k: &PoolKeys, to: &Pubkey, assets: &[Pubkey]) -> Instruction {
    let mut accounts = hook_collectible::accounts::SendPieces {
        user: *user,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        to: *to,
        to_ticket: ticket_of(&k.pool, to),
        mint: k.base_mint,
        from_coins: ata(user, &k.base_mint),
        to_coins: ata(to, &k.base_mint),
        token_program: TOKEN,
        collection: collection_of(&k.pool),
        collection_authority: authority_of(&k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for a in assets {
        accounts.push(AccountMeta::new(*a, false));
    }
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::SendPieces {}.data() }
}

/// A wallet with SOL to trade and no coins.
fn newcomer(env: &mut Env, m: &Market) -> Keypair {
    let w = env.user(5 * SOL);
    env.fund(&w, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    w
}
fn coins(env: &Env, k: &PoolKeys, wallet: &Pubkey) -> u64 {
    env.balance(&ata(wallet, &k.base_mint))
}
/// Sell so that exactly `keep` coins stay in the wallet.
fn sell_down_to(env: &mut Env, user: &Keypair, k: &PoolKeys, keep: u64) {
    let have = coins(env, k, &user.pubkey());
    let hook = hook_for(&k.pool, &user.pubkey());
    env.swap(user, k, &hook, DIRECTION_SELL, have - keep, 0).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
}
/// Buy at `slot`, then mint everything it earned three slots later.
fn buy_and_mint(env: &mut Env, user: &Keypair, k: &PoolKeys, slot: u64, amount: u64) {
    go(env, slot, slot.saturating_sub(10), &[]);
    buy(env, user, k, amount);
    go(env, slot + 3, slot.saturating_sub(10), &[]);
    let t = ticket(env, &k.pool, &user.pubkey());
    let n = t.pending();
    env.ok(&[compute_budget_ix(400_000), mint_ix(&user.pubkey(), k, n as u8, t.minted, n)], &[user]);
}
fn burned(env: &Env, asset: &Pubkey) -> bool {
    let a = env.svm.get_account(asset).expect("the address stays taken");
    a.data.len() == 1 && a.data[0] == 0
}
fn core_owner(env: &Env, asset: &Pubkey) -> Pubkey {
    Pubkey::new_from_array(env.svm.get_account(asset).unwrap().data[1..33].try_into().unwrap())
}

#[test]
fn a_sell_burns_from_the_end_of_the_list_and_the_wallet_chooses_the_order() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let w = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL); // about 9,870 coins: 4 units, capped at 3 pieces
    let a: Vec<Pubkey> = (0..3).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, a);
    let stranger = env.user(SOL);

    // while the coins are there nobody can burn anything, whatever they pass
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[2], a[1]])], &[&stranger]);
    assert_eq!((ticket(&env, &k.pool, &w.pubkey()).owned.len(), cfg(&env, &k.pool).live), (3, 3));
    assert!(!burned(&env, &a[2]));

    // the wallet sells down to two units: one piece is no longer backed
    sell_down_to(&mut env, &w, &k, 2 * UNIT + 5);
    // only the last one of the list can go: passing another piece burns nothing
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[0]])], &[&stranger]);
    assert!(!burned(&env, &a[0]) && ticket(&env, &k.pool, &w.pubkey()).owned.len() == 3);
    let before = env.lamports(&stranger.pubkey());
    let meta = env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[2], a[1]])], &[&stranger]);
    println!("settle with one burn used {} CU", meta.compute_units_consumed);
    assert!(burned(&env, &a[2]), "the newest piece is gone");
    assert!(!burned(&env, &a[1]), "only what is not backed burns, even when more is passed");
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[0], a[1]]);
    assert_eq!(cfg(&env, &k.pool).live, 2);
    assert!(env.lamports(&stranger.pubkey()) > before, "the rent of the burned piece pays whoever settles");

    // the wallet puts its first piece last, then sells one more unit: that one burns
    env.ok(&[reorder_ix(&w.pubkey(), &k, 0, 1)], &[&w]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[1], a[0]]);
    env.err(&[reorder_ix(&w.pubkey(), &k, 0, 2)], &[&w], "no such position");
    env.err(&[reorder_ix(&stranger.pubkey(), &k, 0, 1)], &[&stranger], "");
    sell_down_to(&mut env, &w, &k, UNIT);
    env.ok(&[compute_budget_ix(300_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[a[0]])], &[&w]);
    assert!(burned(&env, &a[0]) && !burned(&env, &a[1]));
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[1]]);

    // one whole coin below a unit and the last piece goes too
    sell_down_to(&mut env, &w, &k, UNIT - 1_000_000);
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[1]])], &[&stranger]);
    assert!(burned(&env, &a[1]));
    assert_eq!((ticket(&env, &k.pool, &w.pubkey()).owned.len(), cfg(&env, &k.pool).live), (0, 0));
}

#[test]
fn waiting_pieces_go_first_and_nothing_unbacked_is_ever_minted() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let w = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL); // 3 minted
    go(&mut env, 110, 100, &[]);
    buy(&mut env, &w, &k, SOL); // 3 waiting, rolls 3..6
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending(), cfg(&env, &k.pool).reserved_pending), (3, 3, 3));

    // sell down to four units: two of the three waiting pieces are dropped, the last rolls
    sell_down_to(&mut env, &w, &k, 4 * UNIT);
    let stranger = env.user(SOL);
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[])], &[&stranger]);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending(), t.rolls), (3, 1, 6), "minted pieces untouched, roll numbers never reused");
    assert_eq!(cfg(&env, &k.pool).reserved_pending, 1);

    // sell everything before minting: the mint drops what is left and mints nothing
    go(&mut env, 113, 100, &[]);
    sell_down_to(&mut env, &w, &k, 0);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 4, 3, 1)], &[&w]);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.pending(), t.minted), (0, 3), "nothing minted without the coins");
    assert!(env.svm.get_account(&asset_of(&k.pool, &w.pubkey(), 3)).map(|a| a.data.is_empty()).unwrap_or(true));
    assert_eq!(cfg(&env, &k.pool).reserved_pending, 0);
    // and the three minted ones are now burnable, last first, in one settle
    let a: Vec<Pubkey> = (0..3).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();
    env.ok(&[compute_budget_ix(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[2], a[1], a[0]])], &[&stranger]);
    assert!(a.iter().all(|x| burned(&env, x)));
    assert_eq!(cfg(&env, &k.pool).live, 0);
}

#[test]
fn coins_moved_out_another_way_do_not_keep_the_piece_alive() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 1);
    let w = newcomer(&mut env, &m);
    let friend = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL);
    let piece = asset_of(&k.pool, &w.pubkey(), 0);

    // a plain token transfer of every coin to a second wallet, then the account is closed
    let all = coins(&env, &k, &w.pubkey());
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &ata(&w.pubkey(), &k.base_mint), &ata(&friend.pubkey(), &k.base_mint), &w.pubkey(), &[], all).unwrap();
    env.ok(&[ix], &[&w]);
    env.close_token_account(&w, &ata(&w.pubkey(), &k.base_mint));

    // the piece did not follow the coins, and it does not survive either
    assert_eq!(core_owner(&env, &piece), w.pubkey());
    let stranger = env.user(SOL);
    // a token account that is not the wallet's own is refused
    let mut wrong = settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[piece]);
    wrong.accounts[3].pubkey = ata(&friend.pubkey(), &k.base_mint);
    env.err(&[compute_budget_ix(300_000), wrong], &[&stranger], "not the wallet's token account");
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[piece])], &[&stranger]);
    assert!(burned(&env, &piece));
    // the friend holds the coins and no piece: coins alone never create one
    assert!(env.svm.get_account(&ticket_of(&k.pool, &friend.pubkey())).map(|a| a.data.is_empty()).unwrap_or(true));
}

#[test]
fn a_piece_moves_only_with_its_coins() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let w = newcomer(&mut env, &m);
    let friend = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL);
    let a: Vec<Pubkey> = (0..3).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();

    // the holder cannot move or burn a piece through Metaplex Core directly: it is frozen
    let direct = |disc: u8, with_new_owner: bool| {
        let mut accounts = vec![
            AccountMeta::new(a[0], false),
            if disc == 12 { AccountMeta::new(collection_of(&k.pool), false) } else { AccountMeta::new_readonly(collection_of(&k.pool), false) },
            AccountMeta::new(w.pubkey(), true),
            AccountMeta::new_readonly(w.pubkey(), true),
        ];
        if with_new_owner {
            accounts.push(AccountMeta::new_readonly(friend.pubkey(), false));
        }
        accounts.push(AccountMeta::new_readonly(system_program::ID, false));
        accounts.push(AccountMeta::new_readonly(MPL_CORE, false));
        Instruction { program_id: MPL_CORE, accounts, data: vec![disc, 0] }
    };
    assert!(env.send(&[direct(14, true)], &[&w]).is_err(), "no plain transfer, no marketplace");
    assert!(env.send(&[direct(12, false)], &[&w]).is_err(), "no burn outside the peg");
    assert_eq!(core_owner(&env, &a[0]), w.pubkey());

    // send_pieces moves the first and the last piece with two units of coins
    let (w_before, f_before) = (coins(&env, &k, &w.pubkey()), coins(&env, &k, &friend.pubkey()));
    let meta = env.ok(&[compute_budget_ix(400_000), send_ix(&w.pubkey(), &k, &friend.pubkey(), &[a[0], a[2]])], &[&w]);
    println!("send of 2 pieces used {} CU", meta.compute_units_consumed);
    assert_eq!(coins(&env, &k, &w.pubkey()), w_before - 2 * UNIT);
    assert_eq!(coins(&env, &k, &friend.pubkey()), f_before + 2 * UNIT);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[1]]);
    let ft = ticket(&env, &k.pool, &friend.pubkey());
    assert_eq!((ft.owned.clone(), ft.user, ft.pool), (vec![a[0], a[2]], friend.pubkey(), k.pool), "a ticket was opened for the receiver");
    assert_eq!((core_owner(&env, &a[0]), core_owner(&env, &a[2])), (friend.pubkey(), friend.pubkey()));
    assert_eq!(cfg(&env, &k.pool).live, 3);

    // both wallets are fully backed: settle burns nothing on either side
    let stranger = env.user(SOL);
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &friend.pubkey(), &[a[2]])], &[&stranger]);
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[1]])], &[&stranger]);
    assert!(!burned(&env, &a[2]) && !burned(&env, &a[1]));

    // nobody sends a piece they do not hold, or somebody else's, or to themselves
    env.err(&[compute_budget_ix(400_000), send_ix(&w.pubkey(), &k, &friend.pubkey(), &[a[0]])], &[&w], "does not hold this piece");
    let mut theft = send_ix(&stranger.pubkey(), &k, &stranger.pubkey(), &[a[1]]);
    theft.accounts[2].pubkey = ticket_of(&k.pool, &w.pubkey());
    assert!(env.send(&[compute_budget_ix(400_000), theft], &[&stranger]).is_err());
    env.err(&[compute_budget_ix(400_000), send_ix(&w.pubkey(), &k, &w.pubkey(), &[a[1]])], &[&w], "to itself");

    // the receiver can buy, mint and send on like anyone, and its list keeps growing
    buy_and_mint(&mut env, &friend, &k, 120, SOL);
    let ft = ticket(&env, &k.pool, &friend.pubkey());
    assert_eq!(ft.owned.len(), 5);
    assert_eq!(&ft.owned[..2], &[a[0], a[2]]);
    env.ok(&[compute_budget_ix(400_000), send_ix(&friend.pubkey(), &k, &w.pubkey(), &[a[0]])], &[&friend]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[1], a[0]]);
    assert_eq!(core_owner(&env, &a[0]), w.pubkey());
}

#[test]
fn supply_counts_the_pieces_that_exist_now() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 2, 3);
    let w = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL);
    let c = cfg(&env, &k.pool);
    assert_eq!((c.minted, c.live), (2, 2));
    go(&mut env, 110, 100, &[]);
    buy(&mut env, &w, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 0, "both exist: nothing left to earn");

    // sell everything, the two pieces burn, and the supply is open again
    sell_down_to(&mut env, &w, &k, 0);
    let a: Vec<Pubkey> = (0..2).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();
    env.ok(&[compute_budget_ix(300_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[a[1], a[0]])], &[&w]);
    assert_eq!(cfg(&env, &k.pool).live, 0);
    buy_and_mint(&mut env, &w, &k, 120, SOL);
    let c = cfg(&env, &k.pool);
    assert_eq!((c.minted, c.live), (4, 2), "new pieces, numbered on from the old ones");
    assert!(asset_text(&env, &asset_of(&k.pool, &w.pubkey(), 2)).contains("Shots #3"));
    assert!(burned(&env, &a[0]) && burned(&env, &a[1]));
}

// ---- found by review, each one a way to block a wallet or dodge the peg -----------------------

/// Rewrite a ticket's list as `n` made-up addresses followed by the pieces it really holds.
fn pad_list(env: &mut Env, pool: &Pubkey, wallet: &Pubkey, n: usize) {
    let key = ticket_of(pool, wallet);
    let mut t = ticket(env, pool, wallet);
    let real = t.owned.clone();
    t.owned = (0..n).map(|_| Pubkey::new_unique()).chain(real).collect();
    let mut data = Vec::new();
    t.try_serialize(&mut data).unwrap();
    let acc = env.svm.get_account(&key).unwrap();
    let lamports = acc.lamports.max(env.svm.minimum_balance_for_rent_exemption(data.len()));
    env.svm.set_account(key, Account { lamports, data, owner: acc.owner, executable: false, rent_epoch: acc.rent_epoch }).unwrap();
}

#[test]
fn lamports_sent_to_a_future_address_block_nothing() {
    let mut env = Env::new();
    // the collection address of a pool that does not exist yet
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    go(&mut env, 50, 40, &[]);
    env.svm.airdrop(&collection_of(&k.pool), 890_880).unwrap();
    let before = env.lamports(&m.creator.pubkey());
    let ix = init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, 1_000, 3);
    env.ok(&[compute_budget_ix(300_000), ix], &[&m.creator]);
    assert_eq!(env.svm.get_account(&collection_of(&k.pool)).unwrap().owner, MPL_CORE, "the collection exists");
    assert!(env.lamports(&m.creator.pubkey()) > before - 10_000_000, "and the stray lamports went to the creator");
    let hook = hook_for(&k.pool, &m.creator.pubkey());
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);

    // the address of a wallet's next piece
    let w = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, &w, &k, SOL);
    go(&mut env, 103, 90, &[]);
    for i in 0..3 {
        env.svm.airdrop(&asset_of(&k.pool, &w.pubkey(), i), 890_880).unwrap();
    }
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.minted, t.owned.len(), t.pending()), (3, 3, 0), "all three minted");
    assert_eq!(core_owner(&env, &asset_of(&k.pool, &w.pubkey(), 0)), w.pubkey());
}

#[test]
fn a_wallet_that_sold_everything_can_buy_and_mint_again() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let w = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL);
    buy_and_mint(&mut env, &w, &k, 110, SOL);
    let a: Vec<Pubkey> = (0..6).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, a);

    // six burned in one settle, passed in no particular order
    sell_down_to(&mut env, &w, &k, 0);
    let meta = env.ok(&[compute_budget_ix(400_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[a[0], a[3], a[5], a[1], a[4], a[2]])], &[&w]);
    println!("settle with six burns used {} CU", meta.compute_units_consumed);
    assert!(a.iter().all(|x| burned(&env, x)));
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 0);

    // the ticket account is now larger than its list: every mint size still works
    go(&mut env, 130, 120, &[]);
    buy(&mut env, &w, &k, SOL);
    go(&mut env, 133, 120, &[]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 1, 6, 1)], &[&w]);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 4, 7, 2)], &[&w]);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.minted, t.pending()), (3, 9, 0));

    // and the way the site buys, a swap with the mint of earlier pieces in one transaction
    go(&mut env, 140, 130, &[]);
    buy(&mut env, &w, &k, SOL);
    go(&mut env, 143, 130, &[]);
    let hook = hook_for(&k.pool, &w.pubkey());
    let swap = env.swap_ix(&w.pubkey(), &k, &hook, DIRECTION_BUY, SOL / 2, 0);
    env.ok(&[compute_budget_ix(600_000), swap, mint_ix(&w.pubkey(), &k, 3, 9, 3)], &[&w]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 6);
}

#[test]
fn reordering_cannot_dodge_a_settle() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 1_000, 3);
    let w = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    buy_and_mint(&mut env, &w, &k, 100, SOL);
    let a: Vec<Pubkey> = (0..3).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();
    // a backed wallet orders its list as it likes
    env.ok(&[reorder_ix(&w.pubkey(), &k, 2, 0)], &[&w]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[2], a[0], a[1]]);

    // above the peg it cannot shuffle any more, so the piece a settle will take is fixed
    sell_down_to(&mut env, &w, &k, 2 * UNIT);
    env.err(&[reorder_ix(&w.pubkey(), &k, 0, 2)], &[&w], "settle it first");
    // nor send its favourite piece away to choose what survives
    let friend = newcomer(&mut env, &m);
    env.err(&[compute_budget_ix(400_000), send_ix(&w.pubkey(), &k, &friend.pubkey(), &[a[1]])], &[&w], "settle it first");
    // and a settle that names the whole list in any order takes exactly the last one
    let stranger = env.user(SOL);
    env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[0], a[1], a[2]])], &[&stranger]);
    assert!(burned(&env, &a[1]) && !burned(&env, &a[0]) && !burned(&env, &a[2]));
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned, vec![a[2], a[0]]);
    env.ok(&[reorder_ix(&w.pubkey(), &k, 0, 1)], &[&w]);
}

#[test]
fn a_wallet_holds_at_most_two_hundred_pieces() {
    let mut env = Env::new();
    let (m, k, _dev) = setup(&mut env, 100_000, 3);
    let w = newcomer(&mut env, &m);
    let friend = newcomer(&mut env, &m);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    env.ok(&[open_ticket_ix(&friend.pubkey(), &k.pool)], &[&friend]);
    buy_and_mint(&mut env, &w, &k, 100, SOL);
    buy_and_mint(&mut env, &w, &k, 110, SOL);
    buy_and_mint(&mut env, &friend, &k, 120, SOL);
    let a: Vec<Pubkey> = (0..6).map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();
    // plenty of coins, and a list of 199: 193 made-up entries in front of the six real ones
    env.mint_to(&m.authority, &m.base_mint, &ata(&w.pubkey(), &k.base_mint), 400 * UNIT);
    pad_list(&mut env, &k.pool, &w.pubkey(), 193);

    // a buy worth three pieces earns the one that still fits, and it mints
    go(&mut env, 130, 120, &[]);
    buy(&mut env, &w, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 1, "199 held: room for one");
    go(&mut env, 133, 120, &[]);
    let meta = env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 4, 6, 1)], &[&w]);
    println!("mint into a list of 199 used {} CU", meta.compute_units_consumed);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 200);
    // full: the next buy still goes through and earns nothing, and nobody can send it more
    go(&mut env, 140, 130, &[]);
    buy(&mut env, &w, &k, SOL);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 0);
    let theirs = asset_of(&k.pool, &friend.pubkey(), 0);
    env.err(&[compute_budget_ix(400_000), send_ix(&friend.pubkey(), &k, &w.pubkey(), &[theirs])], &[&friend], "list is full");

    // a full list is still settled six burns at a time: the newest piece and five of the six
    let all = coins(&env, &k, &w.pubkey());
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &ata(&w.pubkey(), &k.base_mint), &ata(&friend.pubkey(), &k.base_mint), &w.pubkey(), &[], all).unwrap();
    env.ok(&[ix], &[&w]);
    let newest = asset_of(&k.pool, &w.pubkey(), 6);
    let stranger = env.user(SOL);
    let meta = env.ok(&[compute_budget_ix(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[newest, a[5], a[4], a[3], a[2], a[1]])], &[&stranger]);
    println!("settle with six burns on a list of 200 used {} CU", meta.compute_units_consumed);
    assert!(burned(&env, &newest) && (1..6).all(|i| burned(&env, &a[i])) && !burned(&env, &a[0]));
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 194);
}

// ---- final review, 2026-10-12 ---------------------------------------------------------------

fn update_art_ix(owner: &Pubkey, k: &PoolKeys, art: [u8; 16]) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::UpdateCollection {
            owner: *owner,
            cfg: cfg_of(&k.pool),
            collection: collection_of(&k.pool),
            collection_authority: authority_of(&k.pool),
            core_program: MPL_CORE,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::UpdateCollection { args: hook_collectible::UpdateCollectionArgs { name: None, uri_base: None, art: Some(art) } }.data(),
    }
}

#[test]
fn the_art_of_a_piece_is_the_art_in_force_when_it_was_bought() {
    // Final review: a piece was minted with the collection's art as it stood at MINT time.
    // The art bytes carry the rarity odds, so an owner could wait for a buyer's pieces to be
    // revealed, switch the art, and decide what they became; or switch it for its own mint
    // and back, in one transaction. Now a batch keeps the art it was earned under.
    let mut env = Env::new();
    let (m, k, dev) = setup(&mut env, 1_000, 3);
    let t = &m.trader;
    const ART_C: [u8; 16] = [0xCC; 16];
    env.ok(&[open_ticket_ix(&t.pubkey(), &k.pool)], &[t]);
    go(&mut env, 100, 90, &[]);
    buy(&mut env, t, &k, SOL);
    let earned = ticket(&env, &k.pool, &t.pubkey()).pending();
    assert!(earned >= 1);

    // the owner changes the art after the buy, before anything is revealed or minted
    env.ok(&[update_art_ix(&dev.pubkey(), &k, ART_B)], &[&dev]);
    go(&mut env, 103, 90, &[]);
    // and tries the one-transaction switch around the buyer's mint as well: it changes nothing
    env.ok(
        &[compute_budget_ix(600_000), update_art_ix(&dev.pubkey(), &k, ART_C), mint_ix(&t.pubkey(), &k, earned as u8, 0, earned), update_art_ix(&dev.pubkey(), &k, ART_B)],
        &[&dev, t],
    );
    for i in 0..earned {
        let text = asset_text(&env, &asset_of(&k.pool, &t.pubkey(), i));
        assert!(text.contains(&format!("/p/{}/", hexs(&ART_A))), "piece {i} carries the art it was bought under");
        assert!(!text.contains(&hexs(&ART_B)) && !text.contains(&hexs(&ART_C)));
    }

    // a buy made after the change carries the new art
    go(&mut env, 110, 90, &[]);
    buy(&mut env, t, &k, SOL);
    // the art changes again one slot later, while that batch could still take more pieces:
    // the next buy does not join it
    go(&mut env, 111, 90, &[]);
    env.ok(&[update_art_ix(&dev.pubkey(), &k, ART_C)], &[&dev]);
    buy(&mut env, t, &k, SOL);
    let tk = ticket(&env, &k.pool, &t.pubkey());
    let open: Vec<_> = tk.batches.iter().filter(|b| b.pieces > 0).collect();
    assert_eq!(open.len(), 2, "two batches, one per art");
    assert_eq!((open[0].art, open[1].art), (ART_B, ART_C));
    let (first, second) = (open[0].pieces as u32, open[1].pieces as u32);
    go(&mut env, 115, 90, &[]);
    env.ok(&[compute_budget_ix(800_000), mint_ix(&t.pubkey(), &k, first as u8, earned, first)], &[t]);
    env.ok(&[compute_budget_ix(800_000), mint_ix(&t.pubkey(), &k, second as u8, earned + first, second)], &[t]);
    for i in 0..first {
        assert!(asset_text(&env, &asset_of(&k.pool, &t.pubkey(), earned + i)).contains(&format!("/p/{}/", hexs(&ART_B))));
    }
    for i in 0..second {
        assert!(asset_text(&env, &asset_of(&k.pool, &t.pubkey(), earned + first + i)).contains(&format!("/p/{}/", hexs(&ART_C))));
    }
}
