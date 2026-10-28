//! Round 9, reviewer R1: program and deposit economics of hook_collectible after round 8.
//!
//! Every test is an attack on the one-approval change or a check of a claim it makes, from a
//! reviewer who did not write it. A test that passes means the attack failed, EXCEPT the
//! tests whose name starts with `finding_`: those reproduce a weakness this review reports,
//! and pass while the weakness is there.
//!
//! What is attacked here that round 8's review did not cover: a buy whose hook callback meets
//! a ticket at every limit (two hundred pieces, four undecided batches, a stranger's ticket,
//! coins paid into an account that is not the wallet's associated one, a sold-out collection);
//! the compute and the realloc limits of a pegged coin's transfer that burns or moves two
//! hundred pieces at once, with the vault's own ticket squatted; the growth part of a deposit
//! on a plain coin (it never came back: finding, fixed in round 11, now a regression test);
//! the SDK's current deposit sizing against the
//! worst the collection's owner and the piece numbers can do; a keeper meeting a wallet whose
//! token account was closed; and the size of the logs a one-approval buy writes (the crank
//! learns of buys from the PiecesEarned event in them).

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
/// collection is not locked: the longest name (24) and address (80) the owner may still set,
/// and a number of ten digits. 75 + 24 + 2 + 10 + 80 + 68.
const SDK_OPEN_ASSET_SIZE: usize = 75 + 24 + 2 + 10 + 80 + 68;

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
fn open_ticket_for_ix(payer: &Pubkey, pool: &Pubkey, wallet: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OpenTicketFor { payer: *payer, ticket: ticket_of(pool, wallet), system_program: system_program::ID }.to_account_metas(None),
        data: hook_collectible::instruction::OpenTicketFor { pool: *pool, wallet: *wallet }.data(),
    }
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
fn update_collection_ix(owner: &Pubkey, k: &PoolKeys, name: Option<&str>, uri_base: Option<&str>) -> Instruction {
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
        data: hook_collectible::instruction::UpdateCollection {
            args: hook_collectible::UpdateCollectionArgs { name: name.map(Into::into), uri_base: uri_base.map(Into::into), art: None },
        }
        .data(),
    }
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
fn set_owner_ix(owner: &Pubkey, k: &PoolKeys, new_owner: Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::OwnerOnly { owner: *owner, cfg: cfg_of(&k.pool) }.to_account_metas(None),
        data: hook_collectible::instruction::SetOwner { new_owner }.data(),
    }
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
fn queue(env: &Env, k: &PoolKeys) -> Vec<Pubkey> {
    let d = env.svm.get_account(&queue_of(&k.pool)).unwrap().data;
    let n = u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
    (0..n).map(|i| Pubkey::new_from_array(d[Q_ENTRIES + 32 * i..Q_ENTRIES + 32 * (i + 1)].try_into().unwrap())).collect()
}
/// What one signature costs on this chain.
fn signature_fee(env: &mut Env) -> u64 {
    let k = env.user(SOL);
    let before = env.lamports(&k.pubkey());
    env.ok(&[compute_budget_ix(10_000)], &[&k]);
    before - env.lamports(&k.pubkey())
}
/// Exactly what a `mint_for` of `n` pieces costs the wallet's deposit now.
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
/// `mintDepositFor` of sdk/src/collectible.ts as it stands after round 8's fixes: per piece
/// the asset's rent at `depositAssetSize` (the longest name and address while the collection
/// is not locked, the real ones once locked, a ten-digit number), Core's fee, 32 bytes of
/// ticket, one keeper fee.
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
/// Rewrite a ticket's list as `n` made-up entries (a test-only shortcut for `n` earlier
/// mints), keeping its deposit. The wallet's coins are the caller's business.
fn fake_list(env: &mut Env, pool: &Pubkey, user: &Pubkey, n: usize, keep_deposit: u64) {
    let key = ticket_of(pool, user);
    let mut t = ticket(env, pool, user);
    t.owned = (0..n).map(|_| Pubkey::new_unique()).collect();
    let mut data = Vec::new();
    t.try_serialize(&mut data).unwrap();
    let mut acc = env.svm.get_account(&key).unwrap();
    acc.data = data;
    acc.lamports = rent(env, Ticket::space(n)) + keep_deposit;
    env.svm.set_account(key, acc).unwrap();
}
fn set_minted(env: &mut Env, pool: &Pubkey, minted: u32) {
    let key = cfg_of(pool);
    let mut acc = env.svm.get_account(&key).unwrap();
    let mut c: CollectionConfig = env.account(&key);
    c.minted = minted;
    let mut data = Vec::new();
    c.try_serialize(&mut data).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(key, acc).unwrap();
}
/// The books every instruction must keep: each ticket at least its rent and at least as long
/// as its list, the config's counters equal to what the tickets hold.
fn check_books(env: &Env, k: &PoolKeys, wallets: &[Pubkey], what: &str) {
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
    }
    assert_eq!((c.live, c.reserved_pending), (live, pending), "{what}: the config's counters");
}
/// The bytes of a transaction's logs, and whether the PiecesEarned event is among them whole.
fn log_bytes(meta: &litesvm::types::TransactionMetadata) -> (usize, bool, bool) {
    let total: usize = meta.logs.iter().map(|l| l.len()).sum();
    let truncated = meta.logs.iter().any(|l| l.contains("Log truncated"));
    let earned = meta.logs.iter().any(|l| {
        l.starts_with("Program data: ") && {
            use base64::Engine;
            // sha256("event:PiecesEarned")[..8], the SDK's EVENT_DISC.PiecesEarned
            base64::engine::general_purpose::STANDARD.decode(&l["Program data: ".len()..]).map(|b| b.len() >= 92 && b[..8] == [212, 211, 116, 170, 229, 104, 148, 129]).unwrap_or(false)
        }
    });
    (total, truncated, earned)
}

// ---- a plain coin -------------------------------------------------------------------------

fn plain_setup(env: &mut Env, name: &str, uri: &str, max_supply: u32, max_per_buy: u8) -> (Market, PoolKeys) {
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    go(env, 50, 40);
    env.ok(&[cb(300_000), init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, name, uri, max_supply, max_per_buy)], &[&m.creator]);
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
fn sell_all_ix(env: &Env, user: &Pubkey, k: &PoolKeys) -> Instruction {
    env.swap_ix(user, k, &hook_for(&k.pool, user), DIRECTION_SELL, coins(env, k, user), 0)
}
/// The buy the site sends for ONE approval: open the ticket when new, swap, deposit.
fn buy_with_deposit(env: &mut Env, user: &Keypair, k: &PoolKeys, amount: u64, lamports: u64) -> litesvm::types::TransactionMetadata {
    let mut ixs = vec![cb(600_000)];
    if !exists(env, &ticket_of(&k.pool, &user.pubkey())) {
        ixs.push(open_ticket_ix(&user.pubkey(), &k.pool));
    }
    ixs.push(buy_ix(env, &user.pubkey(), k, amount));
    if lamports > 0 {
        ixs.push(deposit_ix(&user.pubkey(), &k.pool, lamports));
    }
    env.ok(&ixs, &[user])
}

// ---- a pegged coin ------------------------------------------------------------------------

struct Peg {
    k: PoolKeys,
    /// Mints the quote.
    authority: Keypair,
    /// Created the coin: its mint authority.
    creator: Keypair,
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
    let ixs = [cb(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, "Pegs", URI_BASE, 100_000, max_per_buy), init_peg_ix(&creator.pubkey(), &k)];
    env.ok(&ixs, &[&creator, &mint]);
    let ix = env.create_pool_ix(&creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &peg_hook_for(&k, &creator.pubkey()));
    env.ok(&[cb(500_000), ix], &[&creator]);
    Peg { k, authority, creator }
}
fn peg_wallet(env: &mut Env, p: &Peg, with_ticket: bool) -> Keypair {
    let w = env.user(5 * SOL);
    let q = env.create_ata(&w, &w.pubkey(), &p.k.quote_mint);
    env.mint_to(&p.authority, &p.k.quote_mint, &q, 50 * SOL);
    env.ok(&[Env::create_ata_with_ix(&w.pubkey(), &w.pubkey(), &p.k.base_mint, &TOKEN_2022)], &[&w]);
    if with_ticket {
        env.ok(&[open_ticket_ix(&w.pubkey(), &p.k.pool)], &[&w]);
    }
    w
}
/// Coins straight from the mint authority (no transfer, no hook): a wallet holding `units` units.
fn peg_coins(env: &mut Env, p: &Peg, to: &Pubkey, units: u64) {
    let ix = t22::instruction::mint_to(&TOKEN_2022, &p.k.base_mint, &coins_of(&p.k, to), &p.creator.pubkey(), &[], units * UNIT).unwrap();
    env.ok(&[ix], &[&p.creator]);
}
fn peg_buy_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &peg_hook_for(k, user), DIRECTION_BUY, amount, 0)
}
fn peg_sell_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &peg_hook_for(k, user), DIRECTION_SELL, amount, 0)
}

// =========================================================================================
// Denial of service: the hook's callback must never fail a buy
// =========================================================================================

#[test]
fn r9_a_buy_never_fails_because_of_the_hook_whatever_the_buyers_ticket_holds() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 1_000, 5);
    let stranger = env.user(SOL);

    // 1. a wallet at the cap: two hundred pieces listed, coins to back them, a deposit
    let full = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &full, &k, SOL, SOL / 10);
    env.mint_to(&m.authority, &m.base_mint, &coins_of(&k, &full.pubkey()), 400 * UNIT);
    let pending_now = ticket(&env, &k.pool, &full.pubkey()).pending() as usize;
    fake_list(&mut env, &k.pool, &full.pubkey(), 200 - pending_now, 777_777);
    let before = ticket(&env, &k.pool, &full.pubkey());
    assert_eq!(before.pieces(), 200);
    go(&mut env, 104, 90);
    let meta = buy_with_deposit(&mut env, &full, &k, SOL, 0);
    let (bytes, truncated, _) = log_bytes(&meta);
    println!("buy by a wallet at the 200-piece cap: {} CU, {bytes} bytes of logs", meta.compute_units_consumed);
    assert!(!truncated);
    let after = ticket(&env, &k.pool, &full.pubkey());
    assert_eq!(after.pieces(), 200, "a full wallet earns nothing");
    assert_eq!(after.rolls, before.rolls);
    assert_eq!(deposit(&env, &k.pool, &full.pubkey()), 777_777, "the callback moved no lamports");
    assert!(meta.compute_units_consumed < 200_000, "an integrator at the default budget still trades: {}", meta.compute_units_consumed);

    // 2. four undecided batches and no empty slot: the fifth buy earns nothing and lands.
    //    (An empty SlotHashes: no block to reveal with, so every batch stays WAITING.)
    let busy = newcomer(&mut env, &m);
    for i in 0..4u64 {
        env.svm.warp_to_slot(200 + 3 * i);
        env.svm.set_sysvar(&SlotHashes::new(&[]));
        buy_with_deposit(&mut env, &busy, &k, SOL / 4, 0);
    }
    let t = ticket(&env, &k.pool, &busy.pubkey());
    assert!(t.batches.iter().all(|b| b.state == hook_collectible::BATCH_WAITING), "{:?}", t.batches.map(|b| b.state));
    env.svm.warp_to_slot(212);
    env.svm.set_sysvar(&SlotHashes::new(&[]));
    let meta = buy_with_deposit(&mut env, &busy, &k, SOL / 4, 0);
    println!("buy with four undecided batches and no slot: {} CU", meta.compute_units_consumed);
    assert_eq!(ticket(&env, &k.pool, &busy.pubkey()).pending(), t.pending(), "nowhere to put them: nothing earned, nothing refused");

    // 3. a ticket a stranger opened for the buyer: the buy earns, the stranger owns nothing
    let gifted = newcomer(&mut env, &m);
    env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &k.pool, &gifted.pubkey())], &[&stranger]);
    go(&mut env, 300, 290);
    env.ok(&[cb(600_000), buy_ix(&env, &gifted.pubkey(), &k, SOL)], &[&gifted]);
    assert_eq!(ticket(&env, &k.pool, &gifted.pubkey()).pending(), 4);

    // 4. the coins paid into a token account that is not the wallet's associated one: the buy
    //    lands, the pieces are recorded, and nothing unbacked is ever minted (NothingToMint)
    let aside = newcomer(&mut env, &m);
    let other_account = env.create_token_account(&aside, &aside.pubkey(), &k.base_mint);
    env.ok(&[open_ticket_ix(&aside.pubkey(), &k.pool)], &[&aside]);
    go(&mut env, 310, 290);
    let mut swap = buy_ix(&env, &aside.pubkey(), &k, SOL);
    assert_eq!(swap.accounts[7].pubkey, coins_of(&k, &aside.pubkey()), "index 7 is user_base");
    swap.accounts[7].pubkey = other_account;
    env.ok(&[cb(600_000), swap, deposit_ix(&aside.pubkey(), &k.pool, SOL / 10)], &[&aside]);
    assert_eq!(ticket(&env, &k.pool, &aside.pubkey()).pending(), 4);
    go(&mut env, 313, 290);
    let held = deposit(&env, &k.pool, &aside.pubkey());
    let e = keeper_send(&mut env, &stranger, &[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &aside.pubkey(), 0, 4)]).unwrap_err();
    assert!(e.contains("NothingToMint"), "{e}");
    assert_eq!(deposit(&env, &k.pool, &aside.pubkey()), held);
    env.ok(&[withdraw_ix(&aside.pubkey(), &k.pool)], &[&aside]);

    // 5. a sold-out collection: the buy lands and earns nothing
    let (m2, k2) = plain_setup(&mut env, NAME, URI_BASE, 3, 5);
    let first = newcomer(&mut env, &m2);
    let second = newcomer(&mut env, &m2);
    go(&mut env, 400, 390);
    buy_with_deposit(&mut env, &first, &k2, SOL, 0);
    assert_eq!(ticket(&env, &k2.pool, &first.pubkey()).pending(), 3);
    let meta = buy_with_deposit(&mut env, &second, &k2, SOL, 0);
    assert_eq!(ticket(&env, &k2.pool, &second.pubkey()).pending(), 0, "sold out: nothing earned");
    assert!(meta.compute_units_consumed < 200_000);
    // (the first pool's books hold the test's made-up list: only its tickets' rent and length are checked)
    for w in [full.pubkey(), busy.pubkey(), gifted.pubkey(), aside.pubkey()] {
        let raw = env.svm.get_account(&ticket_of(&k.pool, &w)).unwrap();
        assert!(raw.data.len() >= Ticket::space(ticket(&env, &k.pool, &w).owned.len()) && raw.lamports >= rent(&env, raw.data.len()));
    }
    check_books(&env, &k2, &[first.pubkey(), second.pubkey()], "sold out");
}

#[test]
fn r9_a_one_approval_buy_writes_its_event_whole_within_the_log_limit() {
    // the mint crank learns of a buy from the PiecesEarned event in the transaction's logs; a
    // transaction whose logs pass 10 KB loses the end of them ("Log truncated")
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, &"N".repeat(24), &format!("https://{}", "u".repeat(72)), 1_000, 5);
    let w = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    let meta = buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    let (bytes, truncated, earned) = log_bytes(&meta);
    println!("one-approval buy on a plain coin: {} CU, {bytes} bytes of logs, PiecesEarned whole: {earned}", meta.compute_units_consumed);
    assert!(!truncated && earned);
    // the same on a pegged coin, whose buy also runs the transfer hook
    let p = peg_setup(&mut env, 5);
    let v = peg_wallet(&mut env, &p, true);
    go(&mut env, 110, 90);
    let meta = env.ok(&[cb(600_000), peg_buy_ix(&env, &v.pubkey(), &p.k, SOL), deposit_ix(&v.pubkey(), &p.k.pool, SOL / 10)], &[&v]);
    let (bytes, truncated, earned) = log_bytes(&meta);
    println!("one-approval buy on a pegged coin: {} CU, {bytes} bytes of logs, PiecesEarned whole: {earned}", meta.compute_units_consumed);
    assert!(!truncated && earned);
    assert!(bytes < 10_000, "the logs stay under the runtime's 10 KB limit with room: {bytes}");
}

// =========================================================================================
// The pegged coin at its limits: two hundred pieces in one transfer
// =========================================================================================

#[test]
fn r9_pegged_two_hundred_pieces_burn_or_move_in_one_transfer_and_no_deposit_moves() {
    let mut env = Env::new();
    let p = peg_setup(&mut env, 5);
    let k = p.k.clone();
    let stranger = env.user(SOL);
    let a = peg_wallet(&mut env, &p, true);
    let b = peg_wallet(&mut env, &p, true);
    let c = peg_wallet(&mut env, &p, true);
    // the vault's own ticket, squatted by a stranger: it must change nothing
    env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &k.pool, &k.pool)], &[&stranger]);
    assert!(exists(&env, &ticket_of(&k.pool, &k.pool)));
    // a and b hold two hundred pieces each, backed by two hundred units; c has a ticket and nothing
    peg_coins(&mut env, &p, &a.pubkey(), 200);
    peg_coins(&mut env, &p, &b.pubkey(), 200);
    fake_list(&mut env, &k.pool, &a.pubkey(), 200, 777_777);
    fake_list(&mut env, &k.pool, &b.pubkey(), 200, 0);
    env.ok(&[deposit_ix(&c.pubkey(), &k.pool, 555_555)], &[&c]);
    let piece = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));

    // 1. a sells everything: two hundred pieces burn into the queue, which grows by 6,400 bytes
    //    on the rent a's ticket frees; a's deposit stays; the sell lands within the SDK's budget
    go(&mut env, 100, 90);
    let q_before = env.lamports(&queue_of(&k.pool));
    let meta = env.ok(&[cb(450_000), peg_sell_ix(&env, &a.pubkey(), &k, coins(&env, &k, &a.pubkey()))], &[&a]);
    println!("pegged sell that burns 200 pieces: {} CU", meta.compute_units_consumed);
    assert_eq!(queue(&env, &k).len(), 200);
    let ta = ticket(&env, &k.pool, &a.pubkey());
    assert_eq!((ta.owned.len(), ticket_len(&env, &k.pool, &a.pubkey())), (0, Ticket::space(0)), "the sender's ticket shrank to its list");
    assert_eq!(deposit(&env, &k.pool, &a.pubkey()), 777_777, "the sender's deposit did not pay for the queue");
    assert_eq!(env.lamports(&queue_of(&k.pool)) - q_before, 200 * piece, "the queue took exactly the rent of its new entries");
    assert!(meta.compute_units_consumed < 450_000);

    // 2. b sends two hundred units to c: two hundred pieces move; c's ticket grows by 6,400
    //    bytes paid by b's freed rent; c's deposit stays, b's (none) stays none
    let meta = env.ok(&[cb(400_000), peg_transfer_ix(&k, &b.pubkey(), &c.pubkey(), 200 * UNIT)], &[&b]);
    println!("pegged transfer that moves 200 pieces: {} CU", meta.compute_units_consumed);
    let (tb, tc) = (ticket(&env, &k.pool, &b.pubkey()), ticket(&env, &k.pool, &c.pubkey()));
    assert_eq!((tb.owned.len(), tc.owned.len()), (0, 200));
    assert_eq!(ticket_len(&env, &k.pool, &c.pubkey()), Ticket::space(200));
    assert_eq!((deposit(&env, &k.pool, &b.pubkey()), deposit(&env, &k.pool, &c.pubkey())), (0, 555_555));
    assert!(meta.compute_units_consumed < 200_000, "a wallet's plain Send at the default budget: {}", meta.compute_units_consumed);

    // 3. c sends them all back to b, whose ticket is now empty and has to grow again: b's
    //    ticket holds exactly its rent, c's deposit pays nothing
    env.ok(&[peg_transfer_ix(&k, &c.pubkey(), &b.pubkey(), 200 * UNIT)], &[&c]);
    assert_eq!((ticket(&env, &k.pool, &b.pubkey()).owned.len(), ticket(&env, &k.pool, &c.pubkey()).owned.len()), (200, 0));
    assert_eq!((deposit(&env, &k.pool, &b.pubkey()), deposit(&env, &k.pool, &c.pubkey())), (0, 555_555));
    assert_eq!(ticket_len(&env, &k.pool, &c.pubkey()), Ticket::space(0));

    // 4. the squatted vault ticket: a buy still earns (a's sell left the pool richer in coins,
    //    so one SOL now buys more than five units: the cap of five) and the pool's ticket
    //    never holds a piece
    go(&mut env, 110, 90);
    env.ok(&[cb(600_000), peg_buy_ix(&env, &c.pubkey(), &k, SOL)], &[&c]);
    assert_eq!(ticket(&env, &k.pool, &c.pubkey()).pending(), 5);
    let vault_ticket = ticket(&env, &k.pool, &k.pool);
    assert_eq!((vault_ticket.owned.len(), vault_ticket.pending()), (0, 0), "the pool's ticket never holds a piece");
    assert_eq!(vault_ticket.user, k.pool);
    // the config's live count follows the fakes the test wrote: check only what the chain did
    assert_eq!(cfg(&env, &k.pool).reserved_pending, 5);
    // and a sell by c right after: its five waiting pieces are dropped, nothing burns, the
    // squatted ticket stays empty
    env.ok(&[cb(450_000), peg_sell_ix(&env, &c.pubkey(), &k, coins(&env, &k, &c.pubkey()))], &[&c]);
    assert_eq!((ticket(&env, &k.pool, &c.pubkey()).pending(), queue(&env, &k).len()), (0, 200));
    assert_eq!(ticket(&env, &k.pool, &k.pool).pieces(), 0);
}

// =========================================================================================
// Fixed in round 11: on a plain coin the growth part of a deposit comes back
// =========================================================================================

#[test]
fn regression_r9_on_a_plain_coin_the_ticket_shrinks_so_the_growth_part_of_a_deposit_comes_back() {
    // Was FINDING R1 L1 (low, economics), fixed in round 11; this test now asserts the fix.
    // Every piece a wallet mints grows its ticket by 32 bytes (222,720 lamports of rent here,
    // 162,560 on mainnet), paid out of the deposit the one-approval buy collected for it ("32
    // bytes of ticket" per piece in mintDepositFor). Before round 11 the ticket kept its length
    // when the pieces burned (a sell and its settle) or left (`send_pieces`), so those lamports
    // stayed in the ticket for good. Now `settle` and the sender's `send_pieces` shrink the
    // ticket to its list after their last CPI, and `withdraw_deposit` shrinks it first: the
    // freed rent is the wallet's deposit and comes back. On a pegged coin nothing changed: the
    // transfer hook already shrank the sender's ticket, and the freed rent pays the burn
    // queue's growth, which goes to whoever reaps (round 11 does not change who pays the queue).
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 1_000, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    let dep = sdk_deposit_for(&env, &cfg(&env, &k.pool), 3);
    buy_with_deposit(&mut env, &w, &k, SOL, dep);
    go(&mut env, 103, 90);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]).unwrap();
    let growth = rent(&env, Ticket::space(3)) - rent(&env, Ticket::space(0));
    let after_mint = deposit(&env, &k.pool, &w.pubkey());
    let pieces: Vec<Pubkey> = ticket(&env, &k.pool, &w.pubkey()).owned.iter().rev().cloned().collect();
    // the wallet sells everything and settles itself: the assets' rent comes back to it
    env.ok(&[cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &pieces)], &[&w]);
    assert!(ticket(&env, &k.pool, &w.pubkey()).owned.is_empty());
    assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), Ticket::space(0), "the list is empty and the ticket shrank to it");
    let left = deposit(&env, &k.pool, &w.pubkey());
    assert_eq!(left, after_mint + growth, "the rent of the three entries joined the deposit");
    let before = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()), before + left - fee);
    let locked = env.lamports(&ticket_of(&k.pool, &w.pubkey())) - rent(&env, Ticket::space(0));
    println!("FIXED: plain coin, three pieces bought, minted by the keeper, sold and settled: {left} lamports came back, {growth} of them the rent of the {} bytes the pieces took; {locked} stay in the ticket", 3 * 32);
    assert_eq!(locked, 0, "nothing above the rent of an empty ticket stays locked");

    // the pegged counterpart, unchanged by round 11: the transfer hook shrinks the ticket in
    // the sell, the freed rent pays the queue's growth and comes back to whoever reaps the
    // burned pieces
    let p = peg_setup(&mut env, 3);
    let v = peg_wallet(&mut env, &p, true);
    let reaper = env.user(SOL);
    go(&mut env, 200, 190);
    let dep = sdk_deposit_for(&env, &cfg(&env, &p.k.pool), 3);
    env.ok(&[cb(600_000), peg_buy_ix(&env, &v.pubkey(), &p.k, SOL), deposit_ix(&v.pubkey(), &p.k.pool, dep)], &[&v]);
    go(&mut env, 203, 190);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &p.k, &v.pubkey(), 0, 3)]).unwrap();
    let after_mint = deposit(&env, &p.k.pool, &v.pubkey());
    let q_before = env.lamports(&queue_of(&p.k.pool));
    env.ok(&[cb(450_000), peg_sell_ix(&env, &v.pubkey(), &p.k, coins(&env, &p.k, &v.pubkey()))], &[&v]);
    assert_eq!(ticket_len(&env, &p.k.pool, &v.pubkey()), Ticket::space(0));
    assert_eq!(deposit(&env, &p.k.pool, &v.pubkey()), after_mint, "the pegged wallet's deposit is unchanged: the freed rent is not in it");
    assert_eq!(env.lamports(&queue_of(&p.k.pool)) - q_before, growth, "it paid the queue's growth");
    let q = queue(&env, &p.k);
    let r0 = env.lamports(&reaper.pubkey());
    env.ok(&[cb(400_000), reap_ix(&reaper.pubkey(), &p.k, &q)], &[&reaper]);
    assert_eq!(env.lamports(&queue_of(&p.k.pool)), q_before, "the queue gave the growth back");
    let reaper_gain = env.lamports(&reaper.pubkey()) + fee - r0;
    println!("pegged coin, the same three pieces: the freed {growth} lamports went to the queue and then to the reaper, who received {reaper_gain} in all (the assets' rent and that)");
    assert!(reaper_gain > growth);
}

// =========================================================================================
// The SDK's deposit sizing against the worst the owner and the numbers can do
// =========================================================================================

#[test]
fn r9_the_sdk_sizing_covers_the_longest_name_and_address_and_ten_digit_numbers() {
    let mut env = Env::new();
    // the shortest collection the program takes, not locked
    let (m, k) = plain_setup(&mut env, "S", "https://a.io", 1_000, 3);
    let v = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    let c0 = cfg(&env, &k.pool);
    assert_ne!(c0.owner, Pubkey::default(), "not locked");
    let sized = sdk_deposit_for(&env, &c0, 3);
    buy_with_deposit(&mut env, &v, &k, SOL, sized);
    // the owner stretches both to the limit, and a billion pieces were numbered before the keeper comes
    let long_uri = format!("https://{}", "a".repeat(72));
    let long_name = "N".repeat(24);
    env.ok(&[cb(300_000), update_collection_ix(&m.creator.pubkey(), &k, Some(long_name.as_str()), Some(long_uri.as_str()))], &[&m.creator]);
    set_minted(&mut env, &k.pool, 999_999_997);
    go(&mut env, 103, 90);
    let cost = mint_for_cost(&env, &k.pool, &v.pubkey(), 3);
    assert!(sized >= cost, "the sizing covers the worst case: {sized} >= {cost}");
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 0, 3)]).unwrap();
    assert_eq!(cfg(&env, &k.pool).minted, 1_000_000_000);
    assert!((0..3).all(|i| core_owner(&env, &asset_of(&k.pool, &v.pubkey(), i)) == v.pubkey()));
    println!("open collection, worst case: sized {sized}, cost {cost}, {} lamports left over", sized - cost);
    assert_eq!(deposit(&env, &k.pool, &v.pubkey()), sized - cost);

    // a locked collection is sized at its real lengths: the owner cannot stretch it any more
    let (m2, k2) = plain_setup(&mut env, "S", "https://a.io", 1_000, 3);
    env.ok(&[set_owner_ix(&m2.creator.pubkey(), &k2, Pubkey::default())], &[&m2.creator]);
    let w = newcomer(&mut env, &m2);
    go(&mut env, 200, 190);
    let c = cfg(&env, &k2.pool);
    assert_eq!(c.owner, Pubkey::default());
    let sized = sdk_deposit_for(&env, &c, 3);
    buy_with_deposit(&mut env, &w, &k2, SOL, sized);
    refused(&mut env, &[cb(300_000), update_collection_ix(&m2.creator.pubkey(), &k2, Some("NNNNNNNNNNNNNNNNNNNNNNNN"), None)], &[&m2.creator], &["Locked"]);
    set_minted(&mut env, &k2.pool, u32::MAX - 3);
    go(&mut env, 203, 190);
    let cost = mint_for_cost(&env, &k2.pool, &w.pubkey(), 3);
    assert!(sized >= cost, "{sized} >= {cost}");
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k2, &w.pubkey(), 0, 3)]).unwrap();
    println!("locked collection at the largest numbers: sized {sized}, cost {cost}, {} lamports left over", sized - cost);
    let open_sized = sdk_deposit_for(&env, &c0, 3);
    println!("the open sizing costs {} lamports more than the locked one for three pieces, all of it withdrawable", open_sized - sized);
}

// =========================================================================================
// The keeper meets wallets that changed under it
// =========================================================================================

#[test]
fn r9_a_keeper_never_pays_for_a_wallet_that_closed_its_token_account_or_sold_through_a_friend() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 1_000, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let friend = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    let start = env.lamports(&keeper.pubkey());
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 10);
    let held = deposit(&env, &k.pool, &w.pubkey());

    // the wallet sells everything and CLOSES its token account before the block: there is no
    // backing account at all. The keeper's simulation says NothingToMint; nothing is paid.
    env.ok(&[cb(600_000), sell_all_ix(&env, &w.pubkey(), &k)], &[&w]);
    env.close_token_account(&w, &coins_of(&k, &w.pubkey()));
    assert!(env.svm.get_account(&coins_of(&k, &w.pubkey())).is_none());
    go(&mut env, 103, 90);
    let e = keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]).unwrap_err();
    assert!(e.contains("NothingToMint"), "{e}");
    assert_eq!(env.lamports(&keeper.pubkey()), start);
    assert_eq!(deposit(&env, &k.pool, &w.pubkey()), held, "a refused call takes nothing");
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 3, "the refused call dropped nothing for good");
    // the wallet takes its deposit back, whole
    let before = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[&w]);
    assert_eq!(env.lamports(&w.pubkey()), before + held - fee);

    // a friend who holds the coins instead: the friend's balance backs nothing of the wallet's
    let x = newcomer(&mut env, &m);
    go(&mut env, 110, 100);
    buy_with_deposit(&mut env, &x, &k, SOL, SOL / 10);
    let all = coins(&env, &k, &x.pubkey());
    let gone = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &coins_of(&k, &x.pubkey()), &coins_of(&k, &friend.pubkey()), &x.pubkey(), &[], all).unwrap();
    env.ok(&[gone], &[&x]);
    go(&mut env, 113, 100);
    // the keeper names the friend's account as the backing: WrongCoins, and nothing moves
    let mut ix = mint_for_ix(&keeper.pubkey(), &k, &x.pubkey(), 0, 3);
    ix.accounts[4].pubkey = coins_of(&k, &friend.pubkey());
    let e = keeper_send(&mut env, &keeper, &[cb(400_000), ix]).unwrap_err();
    assert!(e.contains("WrongCoins"), "{e}");
    let e = keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &x.pubkey(), 0, 3)]).unwrap_err();
    assert!(e.contains("NothingToMint"), "{e}");
    assert_eq!(env.lamports(&keeper.pubkey()), start, "the keeper paid nothing in all of it");
    // the coins come back: the pieces are backed again and the keeper is paid once
    let back = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &coins_of(&k, &friend.pubkey()), &coins_of(&k, &x.pubkey()), &friend.pubkey(), &[], all).unwrap();
    env.ok(&[back], &[&friend]);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &x.pubkey(), 0, 3)]).unwrap();
    assert_eq!(env.lamports(&keeper.pubkey()), start + KEEPER_FEE - fee);
    assert!((0..3).all(|i| core_owner(&env, &asset_of(&k.pool, &x.pubkey(), i)) == x.pubkey()));
    check_books(&env, &k, &[w.pubkey(), x.pubkey(), friend.pubkey()], "closed account");
}

#[test]
fn r9_many_keepers_racing_one_wallet_pay_it_one_fee_and_each_loser_only_its_own_signature() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 1_000, 5);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keepers: Vec<Keypair> = (0..4).map(|_| env.user(SOL)).collect();
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, 2 * SOL, SOL / 5);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 5);
    go(&mut env, 103, 90);
    let held = deposit(&env, &k.pool, &w.pubkey());
    // every keeper simulated at the same moment and sends: the first mints four, the second
    // the fifth, the others find nothing and lose a signature each (the race the crank's
    // backoff is for); the wallet's deposit paid two fees, one per mint that landed
    let cost4 = mint_for_cost(&env, &k.pool, &w.pubkey(), 4);
    let mut landed = 0;
    for (i, kp) in keepers.iter().enumerate() {
        let before = env.lamports(&kp.pubkey());
        match env.send(&[cb(400_000), mint_for_ix(&kp.pubkey(), &k, &w.pubkey(), 0, 4)], &[kp]) {
            Ok(_) => {
                landed += 1;
                assert_eq!(env.lamports(&kp.pubkey()), before + KEEPER_FEE - fee, "keeper {i} was paid once");
            }
            Err(e) => {
                let hay = format!("{:?}\n{}", e.err, e.meta.logs.join("\n"));
                assert!(hay.contains("NothingToMint") || hay.contains("WrongAsset"), "{hay}");
                assert_eq!(before - env.lamports(&kp.pubkey()), fee, "keeper {i} lost only its signature");
            }
        }
    }
    assert_eq!(landed, 1, "a stale first index lands once: the others name the wrong address");
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (4, 1));
    let cost1 = mint_for_cost(&env, &k.pool, &w.pubkey(), 1);
    env.ok(&[cb(400_000), mint_for_ix(&keepers[1].pubkey(), &k, &w.pubkey(), 4, 1)], &[&keepers[1]]);
    assert_eq!(held - deposit(&env, &k.pool, &w.pubkey()), cost4 + cost1, "two mints, two fees, nothing else");
    assert!((0..5).all(|i| core_owner(&env, &asset_of(&k.pool, &w.pubkey(), i)) == w.pubkey()));
    check_books(&env, &k, &[w.pubkey()], "race");
}
