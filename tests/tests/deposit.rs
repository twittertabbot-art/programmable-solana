//! One approval: the buyer pays the NFTs' rent inside the buy as a DEPOSIT (a plain SOL
//! transfer to its own ticket), and anyone mints the pieces into the buyer with
//! `mint_for`, paid back from that deposit. The deposit is what a ticket holds above its
//! rent-exempt minimum. These tests check that it only ever pays for its own wallet's
//! pieces, that a keeper is never out of pocket and never paid twice, and that nothing of
//! section 13's guarantees moves.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use hook_collectible::{Batch, BATCH_REVEALED, BATCH_WAITING, KEEPER_FEE, SLOT_HASHES_ID};
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
const ART: [u8; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const URI_BASE: &str = "https://example.com/art";
/// What Metaplex Core keeps in every asset it creates on top of the rent (its create fee),
/// measured on the Core binary the tests load, which is the mainnet one.
const CORE_FEE: u64 = 1_500_000;

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
    Pubkey::find_program_address(&[hook_collectible::ASSET_SEED, pool.as_ref(), user.as_ref(), &index.to_le_bytes()], &pid()).0
}
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
fn block_hash(slot: u64) -> [u8; 32] {
    hashv(&[b"block", &slot.to_le_bytes()]).to_bytes()
}
/// Move the chain to `slot`; SlotHashes holds every slot in `from..slot`.
fn go(env: &mut Env, slot: u64, from: u64) {
    env.svm.warp_to_slot(slot);
    let v: Vec<(u64, Hash)> = (from..slot).map(|s| (s, Hash::new_from_array(block_hash(s)))).collect();
    env.svm.set_sysvar(&SlotHashes::new(&v));
}
fn expected_piece(pool: &Pubkey, user: &Pubkey, target: u64, first_roll: u32, roll: u32) -> String {
    let seed = hashv(&[&block_hash(target), pool.as_ref(), user.as_ref(), &target.to_le_bytes(), &first_roll.to_le_bytes()]).to_bytes();
    let b = Batch { state: BATCH_REVEALED, pieces: 1, minted_from: 0, first_roll: 0, target_slot: 0, seed, art: [0; 16] };
    hexs(&hook_collectible::piece_seed(&b, roll))
}

// ---- instructions ------------------------------------------------------------------------

fn init_config_ix(payer: &Pubkey, owner: &Pubkey, pool: &Pubkey, max_per_buy: u8) -> Instruction {
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
            args: hook_collectible::InitCollectionArgs { name: "Shots".into(), uri_base: URI_BASE.into(), unit: UNIT, max_supply: 1_000, max_per_buy, art: ART },
        }
        .data(),
    }
}
fn open_ticket_ix(user: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OpenTicket { user: *user, ticket: ticket_of(pool, user), system_program: system_program::ID }.to_account_metas(None),
        data: hook_collectible::instruction::OpenTicket { pool: *pool }.data(),
    }
}
fn reveal_ix(payer: &Pubkey, pool: &Pubkey, user: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::Reveal { payer: *payer, ticket: ticket_of(pool, user), slot_hashes: SLOT_HASHES_ID }.to_account_metas(None),
        data: hook_collectible::instruction::Reveal {}.data(),
    }
}
fn mint_ix(user: &Pubkey, k: &PoolKeys, count: u8, first_index: u32, n: u32) -> Instruction {
    let mut accounts = hook_collectible::accounts::MintPieces {
        user: *user,
        cfg: cfg_of(&k.pool),
        ticket: ticket_of(&k.pool, user),
        coins: ata(user, &k.base_mint),
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
        coins: ata(user, &k.base_mint),
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
        coins: ata(user, &k.base_mint),
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
        accounts: hook_collectible::accounts::Reorder { user: *user, cfg: cfg_of(&k.pool), ticket: ticket_of(&k.pool, user), coins: ata(user, &k.base_mint) }.to_account_metas(None),
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
    accounts.extend(assets.iter().map(|a| AccountMeta::new(*a, false)));
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::SendPieces {}.data() }
}
/// The deposit: a plain SOL transfer from the wallet to its own ticket.
fn deposit_ix(user: &Pubkey, pool: &Pubkey, lamports: u64) -> Instruction {
    system_instruction::transfer(user, &ticket_of(pool, user), lamports)
}

// ---- the world ---------------------------------------------------------------------------

/// Market + config + pool, at slot 50.
fn setup(env: &mut Env, max_per_buy: u8) -> (Market, PoolKeys) {
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    go(env, 50, 40);
    env.ok(&[compute_budget_ix(300_000), init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, max_per_buy)], &[&m.creator]);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook_for(&k.pool, &m.creator.pubkey()));
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    (m, k)
}
fn newcomer(env: &mut Env, m: &Market) -> Keypair {
    let w = env.user(5 * SOL);
    env.fund(&w, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    w
}
fn ticket(env: &Env, pool: &Pubkey, user: &Pubkey) -> hook_collectible::Ticket {
    env.account(&ticket_of(pool, user))
}
fn cfg(env: &Env, pool: &Pubkey) -> hook_collectible::CollectionConfig {
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
    env.balance(&ata(wallet, &k.base_mint))
}
fn exists(env: &Env, key: &Pubkey) -> bool {
    env.svm.get_account(key).map(|a| !a.data.is_empty()).unwrap_or(false)
}
fn core_owner(env: &Env, asset: &Pubkey) -> Pubkey {
    Pubkey::new_from_array(env.svm.get_account(asset).unwrap().data[1..33].try_into().unwrap())
}
fn asset_seed_hex(env: &Env, key: &Pubkey) -> String {
    let text = String::from_utf8_lossy(&env.svm.get_account(key).expect("asset exists").data).to_string();
    let marker = format!("/p/{}/", hexs(&ART));
    let at = text.find(&marker).expect("uri carries the art");
    text[at + marker.len()..at + marker.len() + 32].to_string()
}
/// Exactly what minting `n` pieces numbered from `first_number` costs a deposit through
/// `mint_for`: the ticket's growth to hold them, each asset's rent and Core's fee, one
/// keeper fee.
fn mint_for_cost(env: &Env, pool: &Pubkey, user: &Pubkey, first_number: u32, n: u32) -> u64 {
    let t = ticket(env, pool, user);
    let len = ticket_len(env, pool, user);
    let after = hook_collectible::Ticket::space(t.owned.len() + n as usize).max(len);
    let mut total = rent(env, after) - rent(env, len) + KEEPER_FEE;
    for i in 0..n {
        let name = format!("Shots #{}", first_number + i);
        let asset_len = hook_collectible::core_asset_len(&name, &format!("{URI_BASE}/p/{}/{}", "0".repeat(32), "0".repeat(32)));
        total += rent(env, asset_len) + CORE_FEE;
    }
    total
}
/// What one signature costs on this chain.
fn signature_fee(env: &mut Env) -> u64 {
    let k = env.user(SOL);
    let before = env.lamports(&k.pubkey());
    env.ok(&[compute_budget_ix(10_000)], &[&k]);
    before - env.lamports(&k.pubkey())
}
/// The buy the site sends for ONE approval: open the ticket when new, swap, deposit.
fn buy_with_deposit(env: &mut Env, user: &Keypair, k: &PoolKeys, amount: u64, lamports: u64) {
    let mut ixs = vec![compute_budget_ix(400_000)];
    if !exists(env, &ticket_of(&k.pool, &user.pubkey())) {
        ixs.push(open_ticket_ix(&user.pubkey(), &k.pool));
    }
    ixs.push(env.swap_ix(&user.pubkey(), k, &hook_for(&k.pool, &user.pubkey()), DIRECTION_BUY, amount, 0));
    if lamports > 0 {
        ixs.push(deposit_ix(&user.pubkey(), &k.pool, lamports));
    }
    env.ok(&ixs, &[user]);
}
fn buy(env: &mut Env, user: &Keypair, k: &PoolKeys, amount: u64) {
    env.swap(user, k, &hook_for(&k.pool, &user.pubkey()), DIRECTION_BUY, amount, 0).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
}
fn sell_all(env: &mut Env, user: &Keypair, k: &PoolKeys) {
    let have = coins(env, k, &user.pubkey());
    env.swap(user, k, &hook_for(&k.pool, &user.pubkey()), DIRECTION_SELL, have, 0).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
}
/// Simulate first, send only what the simulation accepts: what a keeper does.
fn keeper_send(env: &mut Env, keeper: &Keypair, ixs: &[Instruction]) -> Result<(), String> {
    use solana_message::{Message, VersionedMessage};
    use solana_transaction::versioned::VersionedTransaction;
    let msg = Message::new_with_blockhash(ixs, Some(&keeper.pubkey()), &env.svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[keeper]).unwrap();
    if let Err(e) = env.svm.simulate_transaction(tx) {
        return Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    }
    env.ok(ixs, &[keeper]);
    Ok(())
}

/// Fails, and the logs or the error name one of `needles`.
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
/// hook_evil's `forward`: call `target` with `metas`, signer flags passed on, the program's
/// own PDA signing at `pda_signer`, a forged signer at `fake_signer`.
fn forward_ix(target: &Pubkey, metas: &[AccountMeta], data: Vec<u8>, pda_signer: Option<u8>, fake_signer: Option<u8>) -> Instruction {
    let mut accounts = hook_evil::accounts::Forward { system_program: system_program::ID }.to_account_metas(None);
    accounts.push(AccountMeta::new_readonly(*target, false));
    accounts.extend(metas.iter().cloned());
    Instruction { program_id: hook_evil::ID, accounts, data: hook_evil::instruction::Forward { data, pda_signer, fake_signer }.data() }
}
fn evil_signer() -> Pubkey {
    Pubkey::find_program_address(&[hook_evil::EVIL_SIGNER_SEED], &hook_evil::ID).0
}
/// The raw bytes of the wallet's first `n` assets.
fn assets_bytes(env: &Env, pool: &Pubkey, user: &Pubkey, n: u32) -> Vec<Vec<u8>> {
    (0..n).map(|i| env.svm.get_account(&asset_of(pool, user, i)).expect("asset").data).collect()
}

// ---- the flow ----------------------------------------------------------------------------

#[test]
fn one_approval_the_buy_deposits_and_anyone_mints_into_the_buyer() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);

    // the buy: open the ticket, swap, deposit, in one transaction the wallet signs once
    go(&mut env, 100, 90);
    let need = 3 * (rent(&env, hook_collectible::core_asset_len("Shots #10", &format!("{URI_BASE}/{}", "0".repeat(68)))) + CORE_FEE + 32 * 6_960 + KEEPER_FEE);
    let swap = env.swap_ix(&w.pubkey(), &k, &hook_for(&k.pool, &w.pubkey()), DIRECTION_BUY, SOL, 0);
    let ixs = vec![compute_budget_ix(400_000), open_ticket_ix(&w.pubkey(), &k.pool), swap, deposit_ix(&w.pubkey(), &k.pool, need)];
    let size = env.tx_size(&ixs, &w.pubkey(), 1);
    println!("one-approval buy (open ticket, swap, deposit): {size} bytes");
    assert!(size <= 1232);
    env.ok(&ixs, &[&w]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 3);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), need, "the deposit is what the ticket holds above its rent");

    // before the block exists nobody can mint: nothing is decided yet
    go(&mut env, 102, 90);
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper], "NothingToMint");
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).batches[0].state, BATCH_WAITING);

    // a keeper mints into the wallet, and is paid back exactly what it spent plus the fee
    go(&mut env, 103, 90);
    let (keeper_before, deposit_before) = (env.lamports(&keeper.pubkey()), deposit(&env, &k.pool, &w.pubkey()));
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 1, 3);
    let wallet_before = env.lamports(&w.pubkey());
    let meta = env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    println!("mint_for of 3 pieces used {} CU", meta.compute_units_consumed);
    assert_eq!(env.lamports(&keeper.pubkey()), keeper_before + KEEPER_FEE - fee, "the keeper gains the fee less its signature, never less");
    assert_eq!(deposit_before - deposit(&env, &k.pool, &w.pubkey()), cost, "the deposit paid the assets, the growth and one fee, nothing more");
    assert_eq!(env.lamports(&w.pubkey()), wallet_before, "the wallet did not sign and paid nothing");
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.pending(), t.minted, t.owned.len()), (0, 3, 3));
    for i in 0..3u32 {
        let a = asset_of(&k.pool, &w.pubkey(), i);
        assert_eq!(core_owner(&env, &a), w.pubkey(), "the piece belongs to the wallet, not the keeper");
        let acc = env.svm.get_account(&a).unwrap();
        assert_eq!(acc.lamports - rent(&env, acc.data.len()), CORE_FEE, "Core keeps its create fee in the asset");
        assert_eq!(asset_seed_hex(&env, &a), expected_piece(&k.pool, &w.pubkey(), 102, 0, i), "the piece block 102 decided");
    }
    let raw = env.svm.get_account(&ticket_of(&k.pool, &w.pubkey())).unwrap();
    assert!(raw.lamports >= rent(&env, raw.data.len()), "never below rent");
    let c = cfg(&env, &k.pool);
    assert_eq!((c.minted, c.live, c.reserved_pending), (3, 3, 0));

    // the rest is the wallet's: it takes it back, the ticket keeps exactly its rent
    let left = deposit(&env, &k.pool, &w.pubkey());
    assert!(left > 0, "the deposit was sized with a margin");
    let before = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()), before + left - fee);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 0);
    env.err(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w], "NoDeposit");
}

#[test]
fn the_pieces_are_the_same_whoever_mints_them_and_whenever() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 2);
    let a = newcomer(&mut env, &m);
    let b = newcomer(&mut env, &m);
    let (k1, k2) = (env.user(SOL), env.user(SOL));
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &a, &k, SOL, SOL / 10);
    buy_with_deposit(&mut env, &b, &k, SOL, SOL / 10);

    // A: one keeper right after the block. B: revealed by a stranger, then minted by another
    // keeper thousands of slots later, after more of the collection was minted in between
    go(&mut env, 103, 90);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&k1.pubkey(), &k, &a.pubkey(), 0, 2)], &[&k1]);
    env.ok(&[reveal_ix(&k1.pubkey(), &k.pool, &b.pubkey())], &[&k1]);
    go(&mut env, 5_000, 4_900);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&k2.pubkey(), &k, &b.pubkey(), 0, 2)], &[&k2]);
    for (w, first) in [(&a, 0u32), (&b, 0u32)] {
        for i in 0..2u32 {
            assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &w.pubkey(), i)), expected_piece(&k.pool, &w.pubkey(), 102, first, i));
        }
    }

    // and a wallet's own mint of the same kind of batch gives what its block says, too
    go(&mut env, 5_010, 4_990);
    buy_with_deposit(&mut env, &a, &k, SOL, 0);
    go(&mut env, 5_013, 4_990);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&a.pubkey(), &k, 2, 2, 2)], &[&a]);
    for i in 2..4u32 {
        assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &a.pubkey(), i)), expected_piece(&k.pool, &a.pubkey(), 5_012, 2, i));
    }
}

#[test]
fn a_keeper_is_paid_once_per_mint_and_cannot_split_a_buy_into_many_fees() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    go(&mut env, 103, 90);

    // one asset address for three decided pieces: refused, it would take three fees
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 1)], &[&keeper], "TooFewAssets");
    // the same mint twice in one transaction: the second finds nothing, and nothing lands
    let twice = [compute_budget_ix(800_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 3, 3)];
    env.err(&twice, &[&keeper], "NothingToMint");
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).minted, 0, "the failed transaction minted nothing");

    // once: paid once
    let before = deposit(&env, &k.pool, &w.pubkey());
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 1, 3);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    assert_eq!(before - deposit(&env, &k.pool, &w.pubkey()), cost);
    // and again: nothing is left to mint, nothing is paid
    let after = deposit(&env, &k.pool, &w.pubkey());
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 3, 3)], &[&keeper], "NothingToMint");
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), after);

    // the wallet's own mint after a keeper's finds nothing either and takes nothing
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 4, 3, 1)], &[&w]);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), after);
}

#[test]
fn a_deposit_pays_only_for_its_own_wallets_pieces() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let victim = newcomer(&mut env, &m);
    let thief = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &victim, &k, SOL, SOL / 10);
    buy_with_deposit(&mut env, &thief, &k, SOL, 0);
    go(&mut env, 103, 90);
    let held = deposit(&env, &k.pool, &victim.pubkey());

    // the thief's pieces paid by the victim's ticket: the ticket is not the thief's
    let mut ix = mint_for_ix(&thief.pubkey(), &k, &thief.pubkey(), 0, 3);
    ix.accounts[3].pubkey = ticket_of(&k.pool, &victim.pubkey());
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&thief]).is_err());
    // the victim's ticket with the thief named as the wallet, so the pieces would be the thief's
    let mut ix = mint_for_ix(&thief.pubkey(), &k, &victim.pubkey(), 0, 3);
    ix.accounts[1].pubkey = thief.pubkey();
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&thief]).is_err());
    // the victim's mint with the thief's coins as the backing
    let mut ix = mint_for_ix(&thief.pubkey(), &k, &victim.pubkey(), 0, 3);
    ix.accounts[4].pubkey = ata(&thief.pubkey(), &k.base_mint);
    env.err(&[compute_budget_ix(400_000), ix], &[&thief], "WrongCoins");
    // the thief's own asset addresses in the victim's mint
    let mut ix = mint_for_ix(&thief.pubkey(), &k, &victim.pubkey(), 0, 3);
    for (j, i) in (10..13).enumerate() {
        ix.accounts[10 + j].pubkey = asset_of(&k.pool, &thief.pubkey(), i);
    }
    env.err(&[compute_budget_ix(400_000), ix], &[&thief], "WrongAsset");
    // the thief's own pieces with no deposit of its own
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&thief.pubkey(), &k, &thief.pubkey(), 0, 3)], &[&thief], "DepositTooSmall");
    // the victim's deposit taken out by anyone but the victim
    let mut ix = withdraw_ix(&thief.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &victim.pubkey());
    assert!(env.send(&[ix], &[&thief]).is_err());
    assert_eq!(deposit(&env, &k.pool, &victim.pubkey()), held, "every attempt failed and took nothing");

    // the thief may only mint the victim's pieces into the victim, and earns the fee for it
    let fee = signature_fee(&mut env);
    let before = env.lamports(&thief.pubkey());
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&thief.pubkey(), &k, &victim.pubkey(), 0, 3)], &[&thief]);
    assert_eq!(env.lamports(&thief.pubkey()), before + KEEPER_FEE - fee);
    for i in 0..3 {
        assert_eq!(core_owner(&env, &asset_of(&k.pool, &victim.pubkey(), i)), victim.pubkey());
    }
}

#[test]
fn a_deposit_on_one_pool_never_pays_for_another_pool() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let (m2, k2) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    env.fund(&w, &m2.authority, &m2.base_mint, &m2.quote_mint, 0, 50 * SOL);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10); // deposit on pool 1
    buy_with_deposit(&mut env, &w, &k2, SOL, 0); // pieces on pool 2, no deposit there
    go(&mut env, 103, 90);
    let held = deposit(&env, &k.pool, &w.pubkey());

    // pool 2's mint with pool 1's ticket: the ticket's address belongs to pool 1
    let mut ix = mint_for_ix(&keeper.pubkey(), &k2, &w.pubkey(), 0, 3);
    ix.accounts[3].pubkey = ticket_of(&k.pool, &w.pubkey());
    env.err(&[compute_budget_ix(400_000), ix], &[&keeper], "ConstraintSeeds");
    // pool 2's own ticket holds nothing
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k2, &w.pubkey(), 0, 3)], &[&keeper], "DepositTooSmall");
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), held);
    assert_eq!(ticket(&env, &k2.pool, &w.pubkey()).minted, 0);
}

#[test]
fn a_short_deposit_is_refused_and_nothing_is_created() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    go(&mut env, 103, 90);
    let exact = mint_for_cost(&env, &k.pool, &w.pubkey(), 1, 3);
    let snapshot = |env: &Env| (env.svm.get_account(&ticket_of(&k.pool, &w.pubkey())).unwrap(), cfg(env, &k.pool).minted);

    // far too little: refused before the first asset (the rent alone is not covered)
    env.ok(&[deposit_ix(&w.pubkey(), &k.pool, exact / 4)], &[&w]);
    let before = snapshot(&env);
    let e = env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper], "DepositTooSmall");
    assert!(!e.meta.logs.iter().any(|l| l.contains(&MPL_CORE.to_string())), "refused before Metaplex Core was called");
    assert_eq!(snapshot(&env), before);
    // one lamport short: the rent is covered, Core's fee is not; found after, nothing remains
    env.ok(&[deposit_ix(&w.pubkey(), &k.pool, exact - exact / 4 - 1)], &[&w]);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), exact - 1);
    let before = snapshot(&env);
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper], "DepositTooSmall");
    assert_eq!(snapshot(&env), before);
    assert!((0..3).all(|i| !exists(&env, &asset_of(&k.pool, &w.pubkey(), i))), "no asset exists");

    // exactly enough: it lands and leaves the ticket at exactly its rent
    env.ok(&[deposit_ix(&w.pubkey(), &k.pool, 1)], &[&w]);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    let raw = env.svm.get_account(&ticket_of(&k.pool, &w.pubkey())).unwrap();
    assert_eq!(raw.lamports, rent(&env, raw.data.len()), "a ticket is never left below its rent, and here exactly at it");
}

#[test]
fn the_wallets_own_mint_takes_from_its_deposit_first() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    go(&mut env, 103, 90);
    // a deposit that covers everything: the wallet's mint costs it only its signature
    let (wallet, held) = (env.lamports(&w.pubkey()), deposit(&env, &k.pool, &w.pubkey()));
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 1, 3) - KEEPER_FEE;
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()), wallet - fee, "paid once, out of the deposit");
    assert_eq!(held - deposit(&env, &k.pool, &w.pubkey()), cost, "the deposit paid the assets and the growth, no keeper fee");

    // a deposit that covers part: the wallet pays exactly the rest
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    go(&mut env, 110, 100);
    buy(&mut env, &w, &k, SOL);
    go(&mut env, 113, 100);
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 4, 3) - KEEPER_FEE;
    let part = cost / 3;
    env.ok(&[deposit_ix(&w.pubkey(), &k.pool, part)], &[&w]);
    let wallet = env.lamports(&w.pubkey());
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 3, 3, 3)], &[&w]);
    assert_eq!(wallet - env.lamports(&w.pubkey()), cost - part + fee, "never twice: the wallet pays what the deposit did not");
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 0);
}

#[test]
fn buy_and_sell_loops_never_cost_the_keeper_anything() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    let start = env.lamports(&keeper.pubkey());
    let mut slot = 100u64;
    let mut mints = 0u64;
    for round in 0..6 {
        go(&mut env, slot, slot - 10);
        let t_minted = if exists(&env, &ticket_of(&k.pool, &w.pubkey())) { ticket(&env, &k.pool, &w.pubkey()).minted } else { 0 };
        buy_with_deposit(&mut env, &w, &k, SOL, SOL / 50);
        if round % 2 == 1 {
            // the wallet sells before the keeper comes: the keeper's simulation says there
            // is nothing to mint, it sends nothing and pays nothing
            sell_all(&mut env, &w, &k);
            go(&mut env, slot + 3, slot - 10);
            let before = env.lamports(&keeper.pubkey());
            let r = keeper_send(&mut env, &keeper, &[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), t_minted, 3)]);
            assert!(r.unwrap_err().contains("NothingToMint"));
            assert_eq!(env.lamports(&keeper.pubkey()), before);
        } else {
            go(&mut env, slot + 3, slot - 10);
            let n = ticket(&env, &k.pool, &w.pubkey()).pending();
            let before = env.lamports(&keeper.pubkey());
            keeper_send(&mut env, &keeper, &[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), t_minted, n)]).unwrap();
            assert_eq!(env.lamports(&keeper.pubkey()), before + KEEPER_FEE - fee);
            mints += 1;
            // the wallet sells and settles itself: it gets the rent of its burned pieces
            sell_all(&mut env, &w, &k);
            let t = ticket(&env, &k.pool, &w.pubkey());
            let burn: Vec<Pubkey> = t.owned.iter().rev().cloned().collect();
            env.ok(&[compute_budget_ix(400_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &burn)], &[&w]);
        }
        let raw = env.svm.get_account(&ticket_of(&k.pool, &w.pubkey())).unwrap();
        assert!(raw.lamports >= rent(&env, raw.data.len()));
        slot += 20;
    }
    assert_eq!(env.lamports(&keeper.pubkey()), start + mints * (KEEPER_FEE - fee), "the keeper only ever gains");
    assert!(mints >= 3);
}

#[test]
fn no_other_instruction_moves_a_deposit_to_its_caller() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    let friend = newcomer(&mut env, &m);
    let stranger = env.user(5 * SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    env.ok(&[open_ticket_ix(&friend.pubkey(), &k.pool)], &[&friend]);
    // both wallets hold a deposit
    env.ok(&[deposit_ix(&w.pubkey(), &k.pool, 777_777)], &[&w]);
    env.ok(&[deposit_ix(&friend.pubkey(), &k.pool, 555_555)], &[&friend]);
    let d = |env: &Env| (deposit(env, &k.pool, &w.pubkey()), deposit(env, &k.pool, &friend.pubkey()));
    assert_eq!(d(&env), (777_777, 555_555));

    // a stranger's reveal, an open of an open ticket, the wallet's reorder: nothing moves
    env.ok(&[reveal_ix(&stranger.pubkey(), &k.pool, &w.pubkey())], &[&stranger]);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    env.ok(&[reorder_ix(&w.pubkey(), &k, 0, 2)], &[&w]);
    assert_eq!(d(&env), (777_777, 555_555));

    // a send grows the receiver's ticket: the sender pays all of it, the receiver's deposit
    // stays. Since round 11 the sender's ticket shrinks by the two entries that left: their
    // rent stays in it and joins the sender's own deposit, it never goes to anyone else.
    let a: Vec<Pubkey> = ticket(&env, &k.pool, &w.pubkey()).owned.clone();
    let sender_before = env.lamports(&w.pubkey());
    let grow = rent(&env, hook_collectible::Ticket::space(2)) - rent(&env, hook_collectible::Ticket::space(0));
    let entry = rent(&env, hook_collectible::Ticket::space(1)) - rent(&env, hook_collectible::Ticket::space(0));
    env.ok(&[compute_budget_ix(400_000), send_ix(&w.pubkey(), &k, &friend.pubkey(), &[a[0], a[1]])], &[&w]);
    assert_eq!(d(&env), (777_777 + 2 * entry, 555_555), "neither deposit paid for the receiver's growth; the sender's freed rent is its own");
    assert!(sender_before - env.lamports(&w.pubkey()) >= grow, "the sender paid the growth");

    // a sell, then a stranger's settle: the burned piece's asset rent goes to the stranger, as
    // before; the rent of the ticket's freed entry stays with the wallet
    sell_all(&mut env, &w, &k);
    env.ok(&[compute_budget_ix(400_000), settle_ix(&stranger.pubkey(), &k, &w.pubkey(), &[a[2]])], &[&stranger]);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 0);
    assert_eq!(d(&env), (777_777 + 3 * entry, 555_555));

    // a stranger's mint_for on a wallet with nothing decided takes nothing
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&stranger.pubkey(), &k, &friend.pubkey(), 0, 4)], &[&stranger], "NothingToMint");
    assert_eq!(d(&env), (777_777 + 3 * entry, 555_555));

    // and each wallet takes its own back
    for (who, amount) in [(&w, 777_777u64 + 3 * entry), (&friend, 555_555)] {
        let before = env.lamports(&who.pubkey());
        env.ok(&[withdraw_ix(&who.pubkey(), &k.pool)], &[who]);
        assert!(env.lamports(&who.pubkey()) + 10_000 > before + amount);
    }
    assert_eq!(d(&env), (0, 0));
}

#[test]
fn lamports_sent_to_a_pieces_address_go_to_the_wallets_deposit_not_the_keeper() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    go(&mut env, 103, 90);
    env.svm.airdrop(&asset_of(&k.pool, &w.pubkey(), 1), 123_456).unwrap();
    let (before, held) = (env.lamports(&keeper.pubkey()), deposit(&env, &k.pool, &w.pubkey()));
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 1, 3);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    assert_eq!(env.lamports(&keeper.pubkey()), before + KEEPER_FEE - fee);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), held - cost + 123_456);
    assert_eq!(core_owner(&env, &asset_of(&k.pool, &w.pubkey(), 1)), w.pubkey());
}

#[test]
fn a_wallet_above_the_peg_gets_nothing_minted_and_keeps_its_deposit() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    // the coins leave by a plain transfer before the block: the pieces are no longer backed
    let friend = newcomer(&mut env, &m);
    let all = coins(&env, &k, &w.pubkey());
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &ata(&w.pubkey(), &k.base_mint), &ata(&friend.pubkey(), &k.base_mint), &w.pubkey(), &[], all - UNIT).unwrap();
    env.ok(&[ix], &[&w]);
    go(&mut env, 103, 90);
    let held = deposit(&env, &k.pool, &w.pubkey());
    // one unit left: one piece stays, two are dropped, and only the one is minted
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (1, 0), "nothing unbacked is minted");
    assert!(!exists(&env, &asset_of(&k.pool, &w.pubkey(), 1)));
    let spent = held - deposit(&env, &k.pool, &w.pubkey());
    let raw = env.svm.get_account(&asset_of(&k.pool, &w.pubkey(), 0)).unwrap();
    assert_eq!(spent, raw.lamports + KEEPER_FEE + rent(&env, hook_collectible::Ticket::space(1)) - rent(&env, hook_collectible::Ticket::space(0)), "one piece's cost, nothing more");
}

#[test]
fn lamport_arithmetic_cannot_wrap() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    // a ticket holding an impossible amount: taking it out would overflow the wallet's balance
    let key = ticket_of(&k.pool, &w.pubkey());
    let acc = env.svm.get_account(&key).unwrap();
    env.svm.set_account(key, Account { lamports: u64::MAX - 1_000, ..acc.clone() }).unwrap();
    let e = env.send(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]).unwrap_err();
    let hay = format!("{:?}\n{}", e.err, e.meta.logs.join("\n"));
    assert!(hay.contains("ArithmeticOverflow") || hay.contains("overflow"), "{hay}");
    env.svm.set_account(key, acc).unwrap();

    // the pure parts, at their limits
    let r = anchor_lang::prelude::Rent::default();
    assert_eq!(hook_collectible::deposit_of(5, 1_000, &r), 0, "below the rent is no deposit, never a negative one");
    assert_eq!(hook_collectible::deposit_of(u64::MAX, 0, &r), u64::MAX - r.minimum_balance(0));
    assert_eq!(hook_collectible::mint_cost_floor(&r, 346, 346, "a", 10, u32::MAX, 2, KEEPER_FEE), None, "a number past u32 is refused, not wrapped");
    assert_eq!(hook_collectible::mint_cost_floor(&r, 346, 346, "a", 10, 1, 1, u64::MAX), None, "a sum past u64 is refused, not wrapped");
    assert!(hook_collectible::mint_cost_floor(&r, 346, 378, "Shots", 91, 1, 1, KEEPER_FEE).unwrap() > r.minimum_balance(378) - r.minimum_balance(346));
}

#[test]
fn an_existing_ticket_starts_with_no_deposit_and_old_mints_are_unchanged() {
    // every ticket made before this change holds exactly its rent: a deposit of 0, so
    // `mint` behaves as before and `mint_for` refuses
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 0);
    go(&mut env, 100, 90);
    buy(&mut env, &w, &k, SOL);
    go(&mut env, 103, 90);
    env.err(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper], "DepositTooSmall");
    let fee = signature_fee(&mut env);
    let before = env.lamports(&w.pubkey());
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 1, 3) - KEEPER_FEE;
    env.ok(&[compute_budget_ix(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    assert_eq!(before - env.lamports(&w.pubkey()), cost + fee, "the wallet pays its pieces as before");
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 0);
    // the layout did not change: the ticket is exactly as long as its list
    let t = ticket(&env, &k.pool, &w.pubkey());
    let mut data = Vec::new();
    t.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), hook_collectible::Ticket::space(3));
    assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), data.len(), "the mint grew it to exactly its list");
}

// ---- adversarial: the owner's list of attacks, each one tried and refused ----------------------
//
// The buyer is always the one who receives the NFT, and nothing but the buyer's own pieces
// is ever paid from its deposit. Every test below tries to break one of those two promises.

/// A victim with three decided pieces and a deposit that covers them, at slot 103. A second
/// wallet `other` with three decided pieces of its own and no deposit.
fn victim_world(env: &mut Env) -> (Market, PoolKeys, Keypair, Keypair) {
    let (m, k) = setup(env, 3);
    let victim = newcomer(env, &m);
    let other = newcomer(env, &m);
    go(env, 100, 90);
    buy_with_deposit(env, &victim, &k, SOL, SOL / 10);
    buy_with_deposit(env, &other, &k, SOL, 0);
    go(env, 103, 90);
    (m, k, victim, other)
}
fn untouched(env: &Env, k: &PoolKeys, victim: &Pubkey, held: u64) {
    assert_eq!(deposit(env, &k.pool, victim), held, "the victim's deposit did not move");
    assert_eq!(ticket(env, &k.pool, victim).minted, 0, "nothing was minted");
    assert!((0..3).all(|i| !exists(env, &asset_of(&k.pool, victim, i))), "no asset exists");
}

#[test]
fn adversarial_no_mint_makes_a_piece_for_anyone_but_the_tickets_wallet() {
    let mut env = Env::new();
    let (_m, k, victim, other) = victim_world(&mut env);
    let attacker = env.user(5 * SOL);
    let keeper = env.user(SOL);
    let held = deposit(&env, &k.pool, &victim.pubkey());
    let v = victim.pubkey();
    let good = || mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3);
    let mut seen = vec![];

    // 1. another owner named as the wallet: the attacker, the payer itself, a second ticket's wallet
    for owner in [attacker.pubkey(), keeper.pubkey(), other.pubkey()] {
        let mut ix = good();
        ix.accounts[1].pubkey = owner;
        seen.push(("mint_for, the victim's ticket with another wallet as owner", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&keeper], &["ConstraintSeeds"])));
    }
    // the victim's wallet with the second wallet's ticket, and the reverse
    let mut ix = good();
    ix.accounts[3].pubkey = ticket_of(&k.pool, &other.pubkey());
    seen.push(("mint_for, the victim as owner of another wallet's ticket", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&keeper], &["ConstraintSeeds"])));
    // 2. asset addresses that are not the victim's next [pool, user, index] addresses
    let fake = Keypair::new();
    for (what, bad) in [
        ("a fresh keypair's address", fake.pubkey()),
        ("the victim's index 1 in place of 0", asset_of(&k.pool, &v, 1)),
        ("the other wallet's index 0", asset_of(&k.pool, &other.pubkey(), 0)),
        ("the attacker's index 0", asset_of(&k.pool, &attacker.pubkey(), 0)),
        ("the victim's index 0 on another pool", asset_of(&Pubkey::new_unique(), &v, 0)),
        ("the payer's own address", keeper.pubkey()),
    ] {
        let mut ix = good();
        ix.accounts[10].pubkey = bad;
        let signers: Vec<&Keypair> = if bad == fake.pubkey() { vec![&keeper, &fake] } else { vec![&keeper] };
        if bad == fake.pubkey() {
            ix.accounts[10].is_signer = true; // even an address whose key signs
        }
        let e = refused(&mut env, &[compute_budget_ix(400_000), ix], &signers, &["WrongAsset"]);
        seen.push((what, e));
    }
    // 3. the wallet's own `mint` signed by someone else for the victim's ticket
    let mut ix = mint_ix(&attacker.pubkey(), &k, 3, 0, 3);
    ix.accounts[2].pubkey = ticket_of(&k.pool, &v);
    seen.push(("mint by the attacker on the victim's ticket", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&attacker], &["ConstraintSeeds"])));
    untouched(&env, &k, &v, held);

    // the only mint that lands puts every piece in the victim's wallet
    env.ok(&[compute_budget_ix(400_000), good()], &[&keeper]);
    for i in 0..3 {
        let a = asset_of(&k.pool, &v, i);
        assert_eq!(core_owner(&env, &a), v);
        assert_eq!(ticket(&env, &k.pool, &v).owned[i as usize], a);
    }
    for (what, err) in &seen {
        println!("refused: {what}: {err}");
    }
}

#[test]
fn adversarial_substituted_accounts_are_refused() {
    let mut env = Env::new();
    let (m, k, victim, _other) = victim_world(&mut env);
    let (m2, k2) = setup(&mut env, 3);
    let v = victim.pubkey();
    // the victim also holds a ticket, pieces and a deposit on a second pool
    env.fund(&victim, &m2.authority, &m2.base_mint, &m2.quote_mint, 0, 50 * SOL);
    go(&mut env, 110, 100);
    buy_with_deposit(&mut env, &victim, &k2, SOL, SOL / 10);
    go(&mut env, 113, 100);
    let keeper = env.user(SOL);
    let attacker = newcomer(&mut env, &m);
    let held = deposit(&env, &k.pool, &v);
    let held2 = deposit(&env, &k2.pool, &v);

    // copies of the victim's config and ticket at addresses that are not theirs, one owned by
    // this program (only a test can make that), one owned by another program
    let cfg_acc = env.svm.get_account(&cfg_of(&k.pool)).unwrap();
    let ticket_acc = env.svm.get_account(&ticket_of(&k.pool, &v)).unwrap();
    let (fake_cfg, fake_cfg_evil, fake_ticket) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
    env.svm.set_account(fake_cfg, cfg_acc.clone()).unwrap();
    env.svm.set_account(fake_cfg_evil, Account { owner: hook_evil::ID, ..cfg_acc.clone() }).unwrap();
    env.svm.set_account(fake_ticket, Account { lamports: ticket_acc.lamports + 100 * SOL, ..ticket_acc.clone() }).unwrap();
    let non_ata = env.create_token_account(&victim, &v, &k.base_mint);

    let cases: Vec<(&str, usize, Pubkey, &[&str])> = vec![
        ("another pool's config", 2, cfg_of(&k2.pool), &["ConstraintHasOne", "ConstraintSeeds"]),
        ("a copy of the config at another address", 2, fake_cfg, &["ConstraintSeeds"]),
        ("a copy of the config owned by another program", 2, fake_cfg_evil, &["AccountOwnedByWrongProgram"]),
        ("the same wallet's ticket on another pool", 3, ticket_of(&k2.pool, &v), &["ConstraintSeeds"]),
        ("a rich copy of the ticket at another address", 3, fake_ticket, &["ConstraintSeeds"]),
        ("the attacker's token account as the backing", 4, ata(&attacker.pubkey(), &k.base_mint), &["WrongCoins"]),
        ("a token account of the victim that is not its associated one", 4, non_ata, &["WrongCoins"]),
        ("the victim's ticket as its token account", 4, ticket_of(&k.pool, &v), &["WrongCoins"]),
        ("another pool's collection", 5, collection_of(&k2.pool), &["ConstraintHasOne"]),
        ("another pool's collection authority", 6, authority_of(&k2.pool), &["ConstraintSeeds"]),
        ("another program as Metaplex Core", 7, hook_evil::ID, &["ConstraintAddress"]),
        ("another program as the system program", 8, TOKEN, &["InvalidProgramId"]),
        ("the Clock sysvar as SlotHashes", 9, Pubkey::from_str_const("SysvarC1ock11111111111111111111111111111111"), &["ConstraintAddress"]),
    ];
    for (what, at, key, needles) in cases {
        let mut ix = mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3);
        ix.accounts[at].pubkey = key;
        let e = refused(&mut env, &[compute_budget_ix(400_000), ix], &[&keeper], needles);
        println!("refused: {what}: {e}");
    }
    // duplicated accounts: one asset three times, the ticket as an asset, the collection as its authority
    let mut ix = mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3);
    ix.accounts[11].pubkey = asset_of(&k.pool, &v, 0);
    ix.accounts[12].pubkey = asset_of(&k.pool, &v, 0);
    println!("refused: the first asset three times: {}", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&keeper], &["WrongAsset"]));
    let mut ix = mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3);
    ix.accounts[10].pubkey = ticket_of(&k.pool, &v);
    println!("refused: the ticket as an asset: {}", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&keeper], &["WrongAsset"]));
    let mut ix = mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3);
    ix.accounts[6].pubkey = collection_of(&k.pool);
    println!("refused: the collection as its own authority: {}", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&keeper], &["ConstraintSeeds"]));
    // withdraw with another wallet's ticket, or the victim's ticket of the other pool by the attacker
    let mut ix = withdraw_ix(&attacker.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k2.pool, &v);
    println!("refused: withdraw of the victim's other ticket: {}", refused(&mut env, &[ix], &[&attacker], &["ConstraintSeeds"]));
    let mut ix = withdraw_ix(&attacker.pubkey(), &k.pool);
    ix.accounts[1].pubkey = fake_ticket;
    println!("refused: withdraw of a rich fake ticket: {}", refused(&mut env, &[ix], &[&attacker], &["ConstraintSeeds"]));
    untouched(&env, &k, &v, held);
    assert_eq!(deposit(&env, &k2.pool, &v), held2);

    // with the right accounts both mints land, each paid by its own pool's deposit
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3)], &[&keeper]);
    assert_eq!(deposit(&env, &k2.pool, &v), held2, "pool 1's mint took nothing from pool 2's deposit");
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k2, &v, 0, 3)], &[&keeper]);
    for pool in [&k.pool, &k2.pool] {
        for i in 0..3 {
            assert_eq!(core_owner(&env, &asset_of(pool, &v, i)), v);
        }
    }
}

#[test]
fn adversarial_nobody_but_the_wallet_draws_its_deposit() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 5);
    let fee = signature_fee(&mut env);
    let victim = newcomer(&mut env, &m);
    let attacker = newcomer(&mut env, &m);
    let v = victim.pubkey();
    // ten decided pieces in two batches
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &victim, &k, 2 * SOL, SOL / 10);
    go(&mut env, 110, 90);
    buy_with_deposit(&mut env, &victim, &k, 2 * SOL, 0);
    go(&mut env, 113, 90);
    assert_eq!(ticket(&env, &k.pool, &v).pending(), 10);

    // two mint_for in one transaction are two real mints of four, each paid for its own pieces
    let held = deposit(&env, &k.pool, &v);
    let cost = mint_for_cost(&env, &k.pool, &v, 1, 4);
    let before = env.lamports(&attacker.pubkey());
    env.ok(&[compute_budget_ix(1_000_000), mint_for_ix(&attacker.pubkey(), &k, &v, 0, 4), mint_for_ix(&attacker.pubkey(), &k, &v, 4, 4)], &[&attacker]);
    assert_eq!(env.lamports(&attacker.pubkey()), before + 2 * KEEPER_FEE - fee, "what it spent, plus a fee per four pieces, nothing more");
    let spent_by_deposit = held - deposit(&env, &k.pool, &v);
    assert!(spent_by_deposit > 2 * cost - 100_000 && spent_by_deposit < 2 * cost + 100_000);
    // the last two, then a third mint in the same transaction finds nothing: all of it fails
    let ixs = [compute_budget_ix(1_000_000), mint_for_ix(&attacker.pubkey(), &k, &v, 8, 2), mint_for_ix(&attacker.pubkey(), &k, &v, 10, 4)];
    println!("refused: a repeated mint_for in one transaction: {}", refused(&mut env, &ixs, &[&attacker], &["NothingToMint"]));
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&attacker.pubkey(), &k, &v, 8, 2)], &[&attacker]);
    assert!((0..10).all(|i| core_owner(&env, &asset_of(&k.pool, &v, i)) == v), "all ten belong to the victim");

    // then the attacker tries to take what is left
    let left = deposit(&env, &k.pool, &v);
    assert!(left > 0);
    let mut ix = withdraw_ix(&attacker.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &v);
    println!("refused: withdraw of the victim's ticket signed by the attacker: {}", refused(&mut env, &[ix], &[&attacker], &["ConstraintSeeds"]));
    let mut ix = withdraw_ix(&v, &k.pool);
    ix.accounts[0].is_signer = false;
    println!("refused: withdraw for the victim without its signature: {}", refused(&mut env, &[ix], &[&attacker], &["AccountNotSigner"]));
    // a withdraw names no destination: the lamports go to the wallet that signed, nowhere else
    let before = env.lamports(&v);
    env.ok(&[withdraw_ix(&v, &k.pool)], &[&victim]);
    assert_eq!(env.lamports(&v), before + left - fee);
}

#[test]
fn adversarial_a_program_calling_in_cannot_take_a_deposit_or_redirect_a_piece() {
    let mut env = Env::new();
    let (_m, k, victim, _other) = victim_world(&mut env);
    let fee = signature_fee(&mut env);
    let attacker = env.user(5 * SOL);
    let v = victim.pubkey();
    let pda = evil_signer();
    env.svm.airdrop(&pda, SOL).unwrap();
    let held = deposit(&env, &k.pool, &v);
    let withdraw_data = hook_collectible::instruction::WithdrawDeposit {}.data();
    let mint_for_data = hook_collectible::instruction::MintFor {}.data();

    // withdraw through the program with the victim forged as a signer: the runtime refuses
    let metas = [AccountMeta::new(v, false), AccountMeta::new(ticket_of(&k.pool, &v), false)];
    let ix = forward_ix(&pid(), &metas, withdraw_data.clone(), None, Some(0));
    println!("refused: withdraw through a program, the victim forged as signer: {}", refused(&mut env, &[ix], &[&attacker], &["PrivilegeEscalation", "signer privilege escalated"]));
    // with the program's own PDA as the wallet and the victim's ticket
    let metas = [AccountMeta::new(pda, false), AccountMeta::new(ticket_of(&k.pool, &v), false)];
    let ix = forward_ix(&pid(), &metas, withdraw_data.clone(), Some(0), None);
    println!("refused: withdraw through a program, its PDA as the wallet: {}", refused(&mut env, &[ix], &[&attacker], &["ConstraintSeeds"]));
    // the victim's own mint, forged signer
    let mut metas = mint_ix(&v, &k, 3, 0, 3).accounts;
    metas[0].is_signer = false;
    let ix = forward_ix(&pid(), &metas, hook_collectible::instruction::Mint { count: 3 }.data(), None, Some(0));
    println!("refused: mint through a program, the victim forged as signer: {}", refused(&mut env, &[compute_budget_ix(600_000), ix], &[&attacker], &["PrivilegeEscalation", "signer privilege escalated"]));
    // mint_for through the program with its PDA named as the owner of the victim's ticket
    let mut metas = mint_for_ix(&pda, &k, &v, 0, 3).accounts;
    metas[0].is_signer = false;
    metas[1].pubkey = pda;
    let ix = forward_ix(&pid(), &metas, mint_for_data.clone(), Some(0), None);
    println!("refused: mint_for through a program, its PDA as the owner: {}", refused(&mut env, &[compute_budget_ix(600_000), ix], &[&attacker], &["ConstraintSeeds"]));
    untouched(&env, &k, &v, held);

    // a program may act as the keeper: its PDA pays and is paid back, the pieces are the victim's
    let mut metas = mint_for_ix(&pda, &k, &v, 0, 3).accounts;
    metas[0].is_signer = false;
    let pda_before = env.lamports(&pda);
    let attacker_before = env.lamports(&attacker.pubkey());
    env.ok(&[compute_budget_ix(600_000), forward_ix(&pid(), &metas, mint_for_data, Some(0), None)], &[&attacker]);
    assert_eq!(env.lamports(&pda), pda_before + KEEPER_FEE, "paid back exactly, plus the fee");
    assert_eq!(env.lamports(&attacker.pubkey()), attacker_before - fee);
    for i in 0..3 {
        assert_eq!(core_owner(&env, &asset_of(&k.pool, &v, i)), v, "the piece went to the buyer");
    }
    // and a program the victim itself signed for can only send the victim's deposit to the victim
    let left = deposit(&env, &k.pool, &v);
    let metas = [AccountMeta::new(v, true), AccountMeta::new(ticket_of(&k.pool, &v), false)];
    let (pda_before, attacker_before, before) = (env.lamports(&pda), env.lamports(&attacker.pubkey()), env.lamports(&v));
    env.ok(&[forward_ix(&pid(), &metas, withdraw_data, None, None)], &[&victim]);
    assert_eq!(env.lamports(&v), before + left - fee);
    assert_eq!((env.lamports(&pda), env.lamports(&attacker.pubkey())), (pda_before, attacker_before));
}

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
fn adversarial_a_front_run_mint_gives_the_buyer_exactly_what_its_own_mint_would() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let buyer = newcomer(&mut env, &m);
    let stranger = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &buyer, &k, SOL, SOL / 10);
    // the collection's owner changes the art after the buy: the batch keeps the art it was bought under
    env.ok(&[update_art_ix(&m.creator.pubkey(), &k, [0xEE; 16])], &[&m.creator]);
    let b = buyer.pubkey();
    let fork = env.svm.clone();

    // A: a stranger front-runs the keeper, at the first slot it can
    go(&mut env, 103, 90);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&stranger.pubkey(), &k, &b, 0, 3)], &[&stranger]);
    let a = assets_bytes(&env, &k.pool, &b, 3);
    // the keeper's own mint, a moment later, finds nothing and pays nothing
    let keeper = env.user(SOL);
    refused(&mut env, &[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &b, 0, 3)], &[&keeper], &["NothingToMint"]);

    // B: on the same chain before A, the buyer mints itself, much later
    let after_a = std::mem::replace(&mut env.svm, fork.clone());
    go(&mut env, 400, 90);
    env.ok(&[reveal_ix(&stranger.pubkey(), &k.pool, &b)], &[&stranger]); // block 102 is still among the last 512
    go(&mut env, 2_000, 1_900);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&b, &k, 3, 0, 3)], &[&buyer]);
    let own = assets_bytes(&env, &k.pool, &b, 3);
    assert_eq!(a, own, "byte for byte the same pieces: owner, name, art and seed");
    for i in 0..3u32 {
        assert_eq!(asset_seed_hex(&env, &asset_of(&k.pool, &b, i)), expected_piece(&k.pool, &b, 102, 0, i), "the art it was bought under, the seed block 102 decided");
        assert_eq!(core_owner(&env, &asset_of(&k.pool, &b, i)), b);
    }

    // C: nobody reveals in time: the keeper and the buyer get the same expired pieces
    env.svm = fork.clone();
    go(&mut env, 1_000, 900);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&stranger.pubkey(), &k, &b, 0, 3)], &[&stranger]);
    let late_keeper = assets_bytes(&env, &k.pool, &b, 3);
    env.svm = fork;
    go(&mut env, 1_000, 900);
    env.ok(&[compute_budget_ix(400_000), mint_ix(&b, &k, 3, 0, 3)], &[&buyer]);
    assert_eq!(assets_bytes(&env, &k.pool, &b, 3), late_keeper, "an expired batch is the same whoever mints it");
    assert!(late_keeper.iter().all(|d| String::from_utf8_lossy(d).contains("/p/")));
    env.svm = after_a;
}

#[test]
fn adversarial_timing_order_and_deposit_size_change_no_piece() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let a = newcomer(&mut env, &m);
    let b = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    // a deposit and a mint in the buy's own transaction: nothing is decided yet
    let mut ixs = vec![compute_budget_ix(800_000), open_ticket_ix(&a.pubkey(), &k.pool)];
    ixs.push(env.swap_ix(&a.pubkey(), &k, &hook_for(&k.pool, &a.pubkey()), DIRECTION_BUY, SOL, 0));
    ixs.push(deposit_ix(&a.pubkey(), &k.pool, SOL / 10));
    let with_mint = [ixs.clone(), vec![mint_for_ix(&a.pubkey(), &k, &a.pubkey(), 0, 3)]].concat();
    println!("refused: a mint in the buy's own transaction: {}", refused(&mut env, &with_mint, &[&a], &["NothingToMint"]));
    env.ok(&ixs, &[&a]);
    buy_with_deposit(&mut env, &b, &k, SOL, SOL / 50);
    let fork = env.svm.clone();
    let seeds = |env: &Env, w: &Pubkey| -> Vec<String> { (0..3).map(|i| asset_seed_hex(env, &asset_of(&k.pool, w, i))).collect() };

    // 1: A then B, right after the block
    go(&mut env, 103, 90);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &a.pubkey(), 0, 3)], &[&keeper]);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &b.pubkey(), 0, 3)], &[&keeper]);
    let one = (seeds(&env, &a.pubkey()), seeds(&env, &b.pubkey()));
    // 2: B then A, three hundred slots later, after A withdrew and paid in again ten times more
    env.svm = fork.clone();
    go(&mut env, 400, 90); // block 102 is still among the last 512
    env.ok(&[withdraw_ix(&a.pubkey(), &k.pool)], &[&a]);
    env.ok(&[deposit_ix(&a.pubkey(), &k.pool, SOL)], &[&a]);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &b.pubkey(), 0, 3)], &[&keeper]);
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &a.pubkey(), 0, 3)], &[&keeper]);
    let two = (seeds(&env, &a.pubkey()), seeds(&env, &b.pubkey()));
    // 3: each wallet mints itself, in one transaction
    env.svm = fork;
    go(&mut env, 200, 100);
    env.ok(&[compute_budget_ix(800_000), mint_ix(&b.pubkey(), &k, 3, 0, 3), mint_ix(&a.pubkey(), &k, 3, 0, 3)], &[&a, &b]);
    let three = (seeds(&env, &a.pubkey()), seeds(&env, &b.pubkey()));
    assert_eq!(one, two, "the order, the time and the size of the deposit change nothing");
    assert_eq!(one, three, "and a mint by the wallet itself gives the same");
    let want: Vec<String> = (0..3).map(|i| expected_piece(&k.pool, &a.pubkey(), 102, 0, i)).collect();
    assert_eq!(one.0, want);
}

#[test]
fn adversarial_keeper_drain_loops_and_dust_deposits() {
    let mut env = Env::new();
    let (m, k) = setup(&mut env, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    let start = env.lamports(&keeper.pubkey());

    // dust: forty deposits of one lamport, in one transaction
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, 0);
    let dust: Vec<Instruction> = (0..40).map(|_| deposit_ix(&w.pubkey(), &k.pool, 1)).collect();
    env.ok(&dust, &[&w]);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), 40);
    go(&mut env, 103, 90);
    let r = keeper_send(&mut env, &keeper, &[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]);
    assert!(r.unwrap_err().contains("DepositTooSmall"), "a dust deposit gets no mint, and the keeper's simulation sees it");
    assert_eq!(env.lamports(&keeper.pubkey()), start);

    // buy, deposit, sell, buy again inside the same window, over and over
    let mut slot = 110u64;
    let mut mints = 0u64;
    for round in 0..8u64 {
        go(&mut env, slot, slot - 10);
        let minted = ticket(&env, &k.pool, &w.pubkey()).minted;
        buy_with_deposit(&mut env, &w, &k, SOL, [1, SOL / 50, 3, SOL / 40][round as usize % 4]);
        sell_all(&mut env, &w, &k);
        if round % 3 != 2 {
            buy_with_deposit(&mut env, &w, &k, SOL / 2, 1);
        }
        go(&mut env, slot + 3, slot - 10);
        let before = env.lamports(&keeper.pubkey());
        match keeper_send(&mut env, &keeper, &[compute_budget_ix(600_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), minted, 4)]) {
            Ok(()) => {
                assert_eq!(env.lamports(&keeper.pubkey()), before + KEEPER_FEE - fee);
                mints += 1;
            }
            Err(e) => {
                assert!(e.contains("NothingToMint") || e.contains("DepositTooSmall"), "{e}");
                assert_eq!(env.lamports(&keeper.pubkey()), before, "a refused simulation costs the keeper nothing");
            }
        }
        // whatever was minted belongs to the wallet
        let t = ticket(&env, &k.pool, &w.pubkey());
        assert!(t.owned.iter().all(|a| core_owner(&env, a) == w.pubkey()));
        if coins(&env, &k, &w.pubkey()) > 0 {
            sell_all(&mut env, &w, &k);
        }
        let burn: Vec<Pubkey> = t.owned.iter().rev().cloned().collect();
        env.ok(&[compute_budget_ix(1_000_000), settle_ix(&w.pubkey(), &k, &w.pubkey(), &burn)], &[&w]);
        slot += 20;
    }
    assert!(mints >= 2, "the loop minted some rounds: {mints}");
    assert_eq!(env.lamports(&keeper.pubkey()), start + mints * (KEEPER_FEE - fee), "the keeper only ever gains");

    // the one race left: the wallet withdraws between the keeper's simulation and its send.
    // The keeper's transaction fails on the chain and costs it one signature; the wallet paid
    // a signature too, plus a buy.
    go(&mut env, slot, slot - 10);
    let minted = ticket(&env, &k.pool, &w.pubkey()).minted;
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    go(&mut env, slot + 3, slot - 10);
    let ixs = [compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), minted, 3)];
    {
        use solana_message::{Message, VersionedMessage};
        use solana_transaction::versioned::VersionedTransaction;
        let msg = Message::new_with_blockhash(&ixs, Some(&keeper.pubkey()), &env.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&keeper]).unwrap();
        assert!(env.svm.simulate_transaction(tx).is_ok(), "the simulation passes");
    }
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    let before = env.lamports(&keeper.pubkey());
    refused(&mut env, &ixs, &[&keeper], &["DepositTooSmall"]);
    assert!(before - env.lamports(&keeper.pubkey()) <= fee, "at most one signature");
}

#[test]
fn adversarial_pieces_minted_for_a_wallet_move_only_like_any_other() {
    // after a mint by someone else, the pieces obey the peg like any piece: only the holder
    // sends them, only an unbacked one burns, and a delivery never hands one to another wallet
    let mut env = Env::new();
    let (m, k, victim, _other) = victim_world(&mut env);
    let keeper = env.user(SOL);
    let thief = newcomer(&mut env, &m);
    let v = victim.pubkey();
    env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &k, &v, 0, 3)], &[&keeper]);
    let a: Vec<Pubkey> = (0..3).map(|i| asset_of(&k.pool, &v, i)).collect();
    env.ok(&[open_ticket_ix(&thief.pubkey(), &k.pool)], &[&thief]);
    env.mint_to(&m.authority, &k.base_mint, &ata(&thief.pubkey(), &k.base_mint), 5 * UNIT);

    // the thief sends the victim's piece to itself: refused
    let mut ix = send_ix(&thief.pubkey(), &k, &thief.pubkey(), &[a[0]]);
    ix.accounts[2].pubkey = ticket_of(&k.pool, &v);
    println!("refused: send of the victim's piece by the thief: {}", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&thief], &["ConstraintSeeds", "SameWallet"]));
    let ix = send_ix(&thief.pubkey(), &k, &v, &[a[0]]);
    println!("refused: send of a piece the thief does not hold: {}", refused(&mut env, &[compute_budget_ix(400_000), ix], &[&thief], &["NotHeld"]));
    // a settle while the victim's coins back everything burns nothing
    env.ok(&[compute_budget_ix(400_000), settle_ix(&thief.pubkey(), &k, &v, &[a[2], a[1], a[0]])], &[&thief]);
    assert_eq!(ticket(&env, &k.pool, &v).owned, a);
    // a reorder of the victim's list by the thief
    let mut ix = reorder_ix(&thief.pubkey(), &k, 0, 2);
    ix.accounts[2].pubkey = ticket_of(&k.pool, &v);
    println!("refused: reorder of the victim's list by the thief: {}", refused(&mut env, &[ix], &[&thief], &["ConstraintSeeds"]));
    for p in &a {
        assert_eq!(core_owner(&env, p), v, "every piece is still the victim's");
    }
}
