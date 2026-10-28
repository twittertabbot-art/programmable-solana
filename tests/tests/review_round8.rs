//! Round 8, independent review of the one-approval change to hook_collectible.
//!
//! Every test below is an attack on the change, or a check of a claim it makes. A test that
//! passes means the attack failed, EXCEPT the tests whose name starts with `finding_`: those
//! reproduce a weakness the review reports, and they pass while the weakness is there.
//!
//! What is attacked: the deposit (what a ticket holds above its rent), `mint_for`,
//! `withdraw_deposit`, the wallet's own `mint` (it now grows the ticket after the Metaplex
//! calls and pays the wallet back from the deposit), `grow_from` in the pegged coin's
//! transfer hook and `send_pieces` (the sender now pays the receiver's growth in full), the
//! SDK's deposit sizing and instruction order, and the meeting of the binary live on mainnet
//! with the new one: tickets, configs and assets the live binary made meet the new code.
//!
//! The upgrade tests load the live binary from `tests/fixtures/hook_collectible_live_r7.so`
//! (sha256 83939dca...835a, the "before" hash of round 8).

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
const LIVE_SO: &str = "hook_collectible_live_r7.so";
const LIVE_SHA256: &str = "83939dcadccee88df8310005c0e7f0e54ed620c0ccd8aa4fec34c750ff46835a";

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
        extra: vec![
            AccountMeta::new(cfg_of(pool), false),
            AccountMeta::new(ticket_of(pool, user), false),
            AccountMeta::new_readonly(SLOT_HASHES_ID, false),
        ],
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
fn burned(env: &Env, asset: &Pubkey) -> bool {
    env.svm.get_account(asset).map(|a| a.data.len() == 1 && a.data[0] == 0).unwrap_or(false)
}
fn queue(env: &Env, k: &PoolKeys) -> Vec<Pubkey> {
    let d = env.svm.get_account(&queue_of(&k.pool)).unwrap().data;
    let n = u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
    (0..n).map(|i| Pubkey::new_from_array(d[Q_ENTRIES + 32 * i..Q_ENTRIES + 32 * (i + 1)].try_into().unwrap())).collect()
}
fn assets_bytes(env: &Env, keys: &[Pubkey]) -> Vec<Vec<u8>> {
    keys.iter().map(|a| env.svm.get_account(a).expect("asset").data).collect()
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
/// `mintDepositFor` of sdk/src/collectible.ts, line for line: per piece the asset's rent with
/// its number counted one digit longer than `(minted + pieces) * 10` has, Core's fee, 32
/// bytes of ticket and one keeper fee.
fn sdk_deposit_for(env: &Env, c: &CollectionConfig, pieces: u32) -> u64 {
    if pieces == 0 {
        return 0;
    }
    let number = (c.minted + pieces) * 10;
    let asset = 75 + format!("{} #{}", c.name, number).len() + c.uri_base.len() + 68;
    (rent(env, asset) + CORE_FEE + (rent(env, 32) - rent(env, 0)) + KEEPER_FEE) * pieces as u64
}
/// The sizing this review proposes: the number counted at its longest (ten digits, u32).
fn review_deposit_for(env: &Env, c: &CollectionConfig, pieces: u32) -> u64 {
    let asset = 75 + c.name.len() + 2 + 10 + c.uri_base.len() + 68;
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
/// Simulate first, send only what the simulation accepts: what a keeper does.
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
fn plain_setup(env: &mut Env, name: &str, uri: &str, max_per_buy: u8) -> (Market, PoolKeys) {
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    go(env, 50, 40);
    env.ok(&[cb(300_000), init_config_ix(&m.creator.pubkey(), &m.creator.pubkey(), &k.pool, name, uri, 1_000, max_per_buy)], &[&m.creator]);
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
fn peg_buy_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &peg_hook_for(k, user), DIRECTION_BUY, amount, 0)
}
fn peg_sell_ix(env: &Env, user: &Pubkey, k: &PoolKeys, amount: u64) -> Instruction {
    env.swap_ix(user, k, &peg_hook_for(k, user), DIRECTION_SELL, amount, 0)
}

// ---- the binaries -------------------------------------------------------------------------

fn live_binary() -> Vec<u8> {
    let p = fixture(LIVE_SO);
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}. The upgrade tests need the binary that is live on mainnet.", p.display()));
    assert_eq!(hexs(&hashv(&[&bytes]).to_bytes()), LIVE_SHA256, "the fixture is the live binary");
    bytes
}
/// Put `bytes` in place of hook_collectible, as an upgrade does, at the chain's current slot.
fn load(env: &mut Env, bytes: &[u8]) {
    env.svm.add_program(pid(), bytes).unwrap();
    let admin = env.admin.pubkey();
    env.patch_upgrade_authority(&pid(), Some(admin));
}

// =========================================================================================
// Findings
// =========================================================================================

#[test]
fn finding_l1_a_buy_that_carries_a_mint_fails_when_anyone_mints_first() {
    // FINDING L1 (low). `swapInstructions` WITHOUT `mintDeposit` (the SDK's default, the
    // API's opt-out, any integrator) puts a `mint` of the wallet's earlier pieces into the
    // buy, with asset addresses taken from the ticket's `minted` counter when it was read.
    // Since round 8 anybody may mint a wallet's decided pieces first (`mint_for`) as soon as
    // its ticket holds a deposit, and the operator's keeper does so within seconds. The
    // counter moves, the buy's `mint` names the wrong address and the WHOLE BUY fails with
    // WrongAsset. Before round 8 only the wallet itself could mint its pieces. A stranger who
    // does it on purpose is even paid the keeper fee. No funds move; the buyer loses a fee
    // and the trade.
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 5);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let stranger = env.user(SOL);

    // case 1: one buy of five pieces with a deposit; mint_for mints four, one stays decided
    go(&mut env, 100, 90);
    let c = cfg(&env, &k.pool);
    let dep = sdk_deposit_for(&env, &c, 5);
    buy_with_deposit(&mut env, &w, &k, 2 * SOL, dep);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 5);
    go(&mut env, 103, 90);
    // the wallet's next buy, built now the way swapInstructions builds it by default
    let t = ticket(&env, &k.pool, &w.pubkey());
    let n = t.pending().min(4);
    let built = vec![cb(600_000), buy_ix(&env, &w.pubkey(), &k, SOL), mint_ix(&w.pubkey(), &k, n as u8, t.minted, n)];
    // before it lands, a stranger mints the wallet's pieces, and is paid for it
    let before = env.lamports(&stranger.pubkey());
    env.ok(&[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &w.pubkey(), 0, 4)], &[&stranger]);
    assert_eq!(env.lamports(&stranger.pubkey()), before + KEEPER_FEE - fee);
    let coins_before = coins(&env, &k, &w.pubkey());
    println!("FINDING L1 case 1: the default buy is refused: {}", refused(&mut env, &built, &[&w], &["WrongAsset"]));
    assert_eq!(coins(&env, &k, &w.pubkey()), coins_before, "the buy did not happen");
    // the one-approval shape carries no mint and lands in the same situation
    env.ok(&[cb(600_000), buy_ix(&env, &w.pubkey(), &k, SOL)], &[&w]);
    assert!(coins(&env, &k, &w.pubkey()) > coins_before);

    // case 2: four pieces in two batches, so nothing is above the four a call mints. The
    // keeper mints the first batch, the second is decided a slot later, the buy lands then.
    let v = newcomer(&mut env, &m);
    go(&mut env, 200, 190);
    let c = cfg(&env, &k.pool);
    let dep = sdk_deposit_for(&env, &c, 4);
    buy_with_deposit(&mut env, &v, &k, SOL / 2, dep);
    let first = ticket(&env, &k.pool, &v.pubkey()).pending();
    go(&mut env, 203, 190);
    buy_with_deposit(&mut env, &v, &k, SOL / 2, 0);
    go(&mut env, 204, 190);
    let t = ticket(&env, &k.pool, &v.pubkey());
    assert!(first >= 1 && t.pending() > first && t.pending() <= 4, "two batches, four pieces at most: {first}, {}", t.pending());
    let n = t.pending().min(4);
    let built = vec![cb(600_000), buy_ix(&env, &v.pubkey(), &k, SOL / 10), mint_ix(&v.pubkey(), &k, n as u8, t.minted, n)];
    env.ok(&[cb(400_000), mint_for_ix(&stranger.pubkey(), &k, &v.pubkey(), 0, first)], &[&stranger]);
    go(&mut env, 206, 190);
    println!("FINDING L1 case 2: the default buy is refused: {}", refused(&mut env, &built, &[&v], &["WrongAsset"]));

    // the fix in the SDK: a buy carries no `mint` while the ticket holds a deposit (or never).
    // Proposed for the program instead: `mint` stops quietly when the first address it is
    // given is not the next one, so a mint inside a buy can never fail the buy.
}

#[test]
fn finding_l2_a_deposit_sized_by_the_sdk_falls_short_when_many_pieces_are_minted_first() {
    // FINDING L2 (low, reliability of the one-approval flow, no loss). `mintDepositFor`
    // counts a piece's number one digit longer than `(minted + pieces) * 10`. On a young
    // collection that is two digits. When a hundred pieces are minted by others before the
    // keeper reaches the wallet (the first minutes of a busy launch), every piece needs three
    // digits and three more bytes of rent: on a buy of three the margin (two spare keeper
    // fees) is 880 lamports short, `mint_for` is refused and the wallet must approve its own
    // mint after all. Nothing is lost: the deposit stays the wallet's.
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let v = newcomer(&mut env, &m);
    let crowd = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    let c0 = cfg(&env, &k.pool);
    assert_eq!(c0.minted, 0);
    let sized = sdk_deposit_for(&env, &c0, 3);
    buy_with_deposit(&mut env, &v, &k, SOL, sized);
    assert_eq!(ticket(&env, &k.pool, &v.pubkey()).pending(), 3);

    // the crowd buys, mints and sells a hundred pieces before the keeper comes to v
    let mut slot = 101u64;
    while cfg(&env, &k.pool).minted < 100 {
        go(&mut env, slot, 90);
        buy_with_deposit(&mut env, &crowd, &k, SOL, 0);
        go(&mut env, slot + 3, 90);
        let t = ticket(&env, &k.pool, &crowd.pubkey());
        let n = t.pending().min(4);
        env.ok(&[cb(400_000), mint_ix(&crowd.pubkey(), &k, n as u8, t.minted, n)], &[&crowd]);
        let burn: Vec<Pubkey> = ticket(&env, &k.pool, &crowd.pubkey()).owned.iter().rev().cloned().collect();
        let sell = sell_all_ix(&env, &crowd.pubkey(), &k);
        env.ok(&[cb(600_000), sell, settle_ix(&crowd.pubkey(), &k, &crowd.pubkey(), &burn)], &[&crowd]);
        slot += 4;
    }
    go(&mut env, slot, 90); // block 102 is still among the last 512
    let r = keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 0, 3)]);
    let short = mint_for_cost(&env, &k.pool, &v.pubkey(), 3) as i64 - sized as i64;
    println!("FINDING L2: minted {} before the keeper; the SDK's deposit is {short} lamports short; mint_for: {}", cfg(&env, &k.pool).minted, r.as_ref().err().map(|e| if e.contains("DepositTooSmall") { "DepositTooSmall" } else { "other" }).unwrap_or("landed"));
    assert!(r.unwrap_err().contains("DepositTooSmall"));
    assert_eq!(deposit(&env, &k.pool, &v.pubkey()), sized, "nothing was taken");

    // the sizing this review proposes (the number at its longest, ten digits) covers it, for
    // at most 62,640 lamports more a piece (nine bytes of rent), all of it withdrawable
    let proposed = review_deposit_for(&env, &c0, 3);
    println!("proposed deposit for three pieces: {proposed} lamports, the SDK's: {sized}");
    env.ok(&[deposit_ix(&v.pubkey(), &k.pool, proposed - sized)], &[&v]);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 0, 3)]).unwrap();
    assert!((0..3).all(|i| core_owner(&env, &asset_of(&k.pool, &v.pubkey(), i)) == v.pubkey()));
    check_books(&env, &k, &[v.pubkey(), crowd.pubkey()], true, "after the crowd");
}

#[test]
fn finding_i1_a_sell_that_meets_the_keeper_hands_the_new_pieces_rent_to_the_settler() {
    // FINDING I1 (info, economics of auto-minting). A wallet that deposited and sells within
    // seconds meets the keeper: the sell the SDK built drops three WAITING pieces, but the
    // keeper's mint landed first, so the pieces are minted assets by the time the sell lands.
    // The sell goes through; its `settle` names no asset, so the three pieces stay above the
    // peg and whoever settles next receives their rent. Before round 8 the same sell cost the
    // wallet nothing (waiting pieces are just dropped). Proposed: the SDK's sell also names
    // the wallet's NEXT asset addresses (`minted .. minted + pending`, known in advance) in
    // its settle (and in a pegged coin's reap): then the seller gets that rent back itself.
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    let settler = env.user(SOL);
    go(&mut env, 100, 90);
    let c = cfg(&env, &k.pool);
    let dep = sdk_deposit_for(&env, &c, 3);
    buy_with_deposit(&mut env, &w, &k, SOL, dep);
    go(&mut env, 103, 90);
    let fork = env.svm.clone();
    let total = |env: &Env| env.lamports(&w.pubkey()) + deposit(env, &k.pool, &w.pubkey());
    let next: Vec<Pubkey> = (0..3).rev().map(|i| asset_of(&k.pool, &w.pubkey(), i)).collect();

    // the reference: the sell lands before any keeper; three waiting pieces are dropped
    let before = total(&env);
    let sell = vec![cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[])];
    env.ok(&sell, &[&w]);
    let t = ticket(&env, &k.pool, &w.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (0, 0));
    let quote_ref = env.balance(&ata(&w.pubkey(), &k.quote_mint));
    let cost_ref = before - total(&env);
    assert_eq!(cost_ref, fee, "without the keeper the sell costs the wallet its signature, the deposit stays whole");

    // A: the same sell, built at the same moment, lands after the keeper's mint
    env.svm = fork.clone();
    let sell = vec![cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &[])];
    let before = total(&env);
    env.ok(&[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    env.ok(&sell, &[&w]);
    assert_eq!(env.balance(&ata(&w.pubkey(), &k.quote_mint)), quote_ref, "the sell itself paid the same");
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 3, "three minted pieces above the peg");
    let s0 = env.lamports(&settler.pubkey());
    env.ok(&[cb(600_000), settle_ix(&settler.pubkey(), &k, &w.pubkey(), &next)], &[&settler]);
    let settler_gain = env.lamports(&settler.pubkey()) + fee - s0;
    let cost_a = before - total(&env);
    println!("FINDING I1: the wallet lost {cost_a} lamports (reference {cost_ref}); the settler received {settler_gain}");
    assert!(settler_gain > 3_000_000, "the settler received the assets' rent");
    assert!(cost_a > cost_ref + 3 * CORE_FEE, "the wallet paid the pieces and lost them");

    // C: the proposed sell names the next asset addresses too: the seller burns them itself
    env.svm = fork;
    let sell = vec![cb(600_000), sell_all_ix(&env, &w.pubkey(), &k), settle_ix(&w.pubkey(), &k, &w.pubkey(), &next)];
    let before = total(&env);
    env.ok(&[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)], &[&keeper]);
    env.ok(&sell, &[&w]);
    assert!(ticket(&env, &k.pool, &w.pubkey()).owned.is_empty(), "burned in the sell");
    let cost_c = before - total(&env);
    println!("with the next addresses named: the wallet lost {cost_c} lamports (Core's fee and the burned assets' one-byte rent stay behind)");
    assert_eq!(cost_a - cost_c, settler_gain, "the rent the settler got in A came back to the seller");
    check_books(&env, &k, &[w.pubkey()], true, "after the sell");
}

#[test]
fn finding_i2_the_collections_owner_can_make_every_waiting_deposit_fall_short() {
    // FINDING I2 (info). The launcher may lengthen the collection's name (24 bytes) and
    // renderer address (80) until it locks the collection. Every asset minted afterwards is
    // larger, and deposits sized for the old lengths no longer cover `mint_for`: the keeper
    // is refused, and every waiting wallet must approve its own mint. Nothing is lost. The SDK
    // could size for 24 and 80 bytes while the collection is not locked (about 0.0006 SOL a
    // piece more, all of it withdrawable), or the site can accept the fallback.
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, "S", "https://a.io", 3);
    let fee = signature_fee(&mut env);
    let v = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    let c = cfg(&env, &k.pool);
    let sized = sdk_deposit_for(&env, &c, 3);
    buy_with_deposit(&mut env, &v, &k, SOL, sized);
    let long_uri = format!("https://{}", "a".repeat(72));
    let long_name = "N".repeat(24);
    assert_eq!(long_uri.len(), 80);
    env.ok(&[cb(300_000), update_collection_ix(&m.creator.pubkey(), &k, Some(long_name.as_str()), Some(long_uri.as_str()))], &[&m.creator]);
    go(&mut env, 103, 90);
    let r = keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 0, 3)]);
    assert!(r.unwrap_err().contains("DepositTooSmall"));
    assert_eq!(deposit(&env, &k.pool, &v.pubkey()), sized);
    // the wallet's own mint takes the deposit first and pays the rest
    let before = env.lamports(&v.pubkey()) + deposit(&env, &k.pool, &v.pubkey());
    let cost = mint_for_cost(&env, &k.pool, &v.pubkey(), 3) - KEEPER_FEE;
    env.ok(&[cb(400_000), mint_ix(&v.pubkey(), &k, 3, 0, 3)], &[&v]);
    assert_eq!(before - env.lamports(&v.pubkey()) - deposit(&env, &k.pool, &v.pubkey()), cost + fee);
    println!("FINDING I2: after the owner's update the pieces cost {} lamports more than the SDK sized", cost + KEEPER_FEE - sized);
}

// =========================================================================================
// The upgrade: what the live binary made meets the new code
// =========================================================================================

#[test]
fn r8_upgrade_from_the_live_binary_keeps_every_ticket_config_and_piece() {
    let live = live_binary();
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &live);
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let (a, b, c, d) = (newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m));
    let stranger = env.user(30 * SOL);
    let keeper = env.user(SOL);
    let all = [a.pubkey(), b.pubkey(), c.pubkey(), d.pubkey()];

    // under the LIVE binary:
    // A: three pieces, two minted with count 4: the old realloc grew the ticket for four
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &a, &k, SOL, 0);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 4, 0, 2)], &[&a]);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), ticket(&env, &k.pool, &a.pubkey()).owned.len()), (Ticket::space(4), 2));
    // B: a stranger sent 0.03 SOL to B's ticket address before it existed, B opened it and bought
    env.ok(&[system_instruction::transfer(&stranger.pubkey(), &ticket_of(&k.pool, &b.pubkey()), 30_000_000)], &[&stranger]);
    env.ok(&[open_ticket_ix(&b.pubkey(), &k.pool)], &[&b]);
    go(&mut env, 110, 90);
    buy_with_deposit(&mut env, &b, &k, SOL, 0);
    // C: a buy whose block comes after the upgrade
    go(&mut env, 118, 90);
    buy_with_deposit(&mut env, &c, &k, SOL, 0);
    // D: a ticket a stranger opened, nothing bought
    env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &k.pool, &d.pubkey())], &[&stranger]);
    check_books(&env, &k, &all, true, "live binary");

    // the reference: what the LIVE binary mints at slot 125 for A's third piece, B and C
    let fork = env.svm.clone();
    go(&mut env, 125, 90);
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 1, 2, 1)], &[&a]);
    env.ok(&[cb(400_000), mint_ix(&b.pubkey(), &k, 3, 0, 3)], &[&b]);
    env.ok(&[cb(400_000), mint_ix(&c.pubkey(), &k, 3, 0, 3)], &[&c]);
    let pieces: Vec<Pubkey> = [asset_of(&k.pool, &a.pubkey(), 2)]
        .into_iter()
        .chain((0..3).map(|i| asset_of(&k.pool, &b.pubkey(), i)))
        .chain((0..3).map(|i| asset_of(&k.pool, &c.pubkey(), i)))
        .collect();
    let want = assets_bytes(&env, &pieces);

    // THE UPGRADE, at slot 119: C's block (120) is not produced yet
    env.svm = fork;
    go(&mut env, 119, 90);
    load(&mut env, &new);
    check_books(&env, &k, &all, true, "right after the upgrade");
    assert_eq!(deposit(&env, &k.pool, &a.pubkey()), 0, "a ticket the old realloc grew holds no deposit");
    assert_eq!(deposit(&env, &k.pool, &b.pubkey()), 30_000_000 - rent(&env, Ticket::space(0)), "the old surplus is B's deposit");
    assert_eq!((deposit(&env, &k.pool, &c.pubkey()), deposit(&env, &k.pool, &d.pubkey())), (0, 0));
    // nobody but B takes B's surplus
    let mut ix = withdraw_ix(&stranger.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &b.pubkey());
    refused(&mut env, &[ix], &[&stranger], &["ConstraintSeeds"]);
    let mut ix = mint_for_ix(&stranger.pubkey(), &k, &stranger.pubkey(), 0, 3);
    ix.accounts[3].pubkey = ticket_of(&k.pool, &b.pubkey());
    refused(&mut env, &[cb(400_000), ix], &[&stranger], &["ConstraintSeeds"]);

    go(&mut env, 125, 90);
    // A mints its third piece itself: the old room holds it, nothing grows, the wallet pays the asset only
    let before = env.lamports(&a.pubkey());
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 1, 2, 1)], &[&a]);
    let asset = env.svm.get_account(&asset_of(&k.pool, &a.pubkey(), 2)).unwrap();
    assert_eq!(before - env.lamports(&a.pubkey()), asset.lamports + fee);
    assert_eq!((ticket_len(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &a.pubkey())), (Ticket::space(4), 0));
    // B: the keeper mints from B's old surplus, into B
    let kb = env.lamports(&keeper.pubkey());
    let cost = mint_for_cost(&env, &k.pool, &b.pubkey(), 3);
    let held = deposit(&env, &k.pool, &b.pubkey());
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &b.pubkey(), 0, 3)]).unwrap();
    assert_eq!(env.lamports(&keeper.pubkey()), kb + KEEPER_FEE - fee);
    assert_eq!(held - deposit(&env, &k.pool, &b.pubkey()), cost);
    // C: tops its deposit up with a plain transfer, the keeper mints
    env.ok(&[deposit_ix(&c.pubkey(), &k.pool, 20_000_000)], &[&c]);
    keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &c.pubkey(), 0, 3)]).unwrap();
    // byte for byte what the live binary would have minted: owner, number, art and seed
    assert_eq!(assets_bytes(&env, &pieces), want, "the upgrade changes no piece");
    for p in &pieces {
        assert!(core_owner(&env, p) == a.pubkey() || core_owner(&env, p) == b.pubkey() || core_owner(&env, p) == c.pubkey());
    }
    // what is left goes back to B and C only; D has nothing to take, nothing to mint
    for w in [&b, &c] {
        let left = deposit(&env, &k.pool, &w.pubkey());
        let before = env.lamports(&w.pubkey());
        env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
        assert_eq!(env.lamports(&w.pubkey()), before + left - fee);
    }
    refused(&mut env, &[withdraw_ix(&d.pubkey(), &k.pool)], &[&d], &["NoDeposit"]);
    refused(&mut env, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &d.pubkey(), 0, 1)], &[&keeper], &["NothingToMint"]);
    // a sell and a settle on the old tickets still burn exactly the end of the list
    let sell = sell_all_ix(&env, &a.pubkey(), &k);
    let burn: Vec<Pubkey> = ticket(&env, &k.pool, &a.pubkey()).owned.iter().rev().cloned().collect();
    env.ok(&[cb(600_000), sell, settle_ix(&a.pubkey(), &k, &a.pubkey(), &burn)], &[&a]);
    assert!(burn.iter().all(|p| burned(&env, p)));
    check_books(&env, &k, &all, true, "after the upgrade");
}

#[test]
fn r8_upgrade_from_the_live_binary_keeps_pegged_tickets_and_their_surplus() {
    let live = live_binary();
    let new = so("hook_collectible");
    let mut env = Env::new();
    go(&mut env, 5, 0);
    load(&mut env, &live);
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let fee = signature_fee(&mut env);
    let e = peg_wallet(&mut env, &p, true);
    let f = peg_wallet(&mut env, &p, true);
    let g = peg_wallet(&mut env, &p, true);
    let stranger = env.user(SOL);
    let all = [e.pubkey(), f.pubkey(), g.pubkey()];

    // under the LIVE binary: E holds three pieces; F three, two minted with count 4 (room for two more)
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &e.pubkey(), &k, SOL)], &[&e]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&e.pubkey(), &k, 3, 0, 3)], &[&e]);
    go(&mut env, 110, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &f.pubkey(), &k, SOL)], &[&f]);
    go(&mut env, 113, 90);
    env.ok(&[cb(400_000), mint_ix(&f.pubkey(), &k, 4, 0, 2)], &[&f]);
    assert_eq!(ticket_len(&env, &k.pool, &f.pubkey()), Ticket::space(4));
    // E sells down to three units and sends one to F: E's last piece moves into F's spare room,
    // so the live binary moves no lamports and E's ticket keeps the rent of the bytes it freed
    let sell = peg_sell_ix(&env, &e.pubkey(), &k, coins(&env, &k, &e.pubkey()) - 3 * UNIT);
    env.ok(&[cb(400_000), sell], &[&e]);
    let moved = ticket(&env, &k.pool, &e.pubkey()).owned[2];
    env.ok(&[peg_transfer_ix(&k, &e.pubkey(), &f.pubkey(), UNIT)], &[&e]);
    assert_eq!(ticket(&env, &k.pool, &f.pubkey()).owned[2], moved);
    let surplus = env.lamports(&ticket_of(&k.pool, &e.pubkey())) - rent(&env, ticket_len(&env, &k.pool, &e.pubkey()));
    assert_eq!(surplus, rent(&env, Ticket::space(3)) - rent(&env, Ticket::space(2)));
    check_books(&env, &k, &all, false, "live binary");

    // THE UPGRADE
    go(&mut env, 119, 90);
    load(&mut env, &new);
    check_books(&env, &k, &all, false, "right after the upgrade");
    assert_eq!(deposit(&env, &k.pool, &e.pubkey()), surplus, "E's freed rent is E's deposit now");
    let mut ix = withdraw_ix(&stranger.pubkey(), &k.pool);
    ix.accounts[1].pubkey = ticket_of(&k.pool, &e.pubkey());
    refused(&mut env, &[ix], &[&stranger], &["ConstraintSeeds"]);
    let before = env.lamports(&e.pubkey());
    env.ok(&[withdraw_ix(&e.pubkey(), &k.pool)], &[&e]);
    assert_eq!(env.lamports(&e.pubkey()), before + surplus - fee);

    // F mints its waiting piece itself: the old room holds it
    go(&mut env, 125, 90);
    let t = ticket(&env, &k.pool, &f.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (3, 1));
    env.ok(&[cb(400_000), mint_ix(&f.pubkey(), &k, 1, t.minted, 1)], &[&f]);
    assert_eq!((ticket_len(&env, &k.pool, &f.pubkey()), deposit(&env, &k.pool, &f.pubkey())), (Ticket::space(4), 0));
    // transfers go on: F sends two units to G, one piece moves, G's ticket grows on F's freed rent, G's deposit stays
    env.ok(&[deposit_ix(&g.pubkey(), &k.pool, 777_777)], &[&g]);
    let keep = 4 * UNIT - 1; // F's coins back three pieces after the transfer
    let send = coins(&env, &k, &f.pubkey()) - keep;
    env.ok(&[peg_transfer_ix(&k, &f.pubkey(), &g.pubkey(), send)], &[&f]);
    let tg = ticket(&env, &k.pool, &g.pubkey());
    assert_eq!(tg.owned.len(), 1);
    assert_eq!((deposit(&env, &k.pool, &g.pubkey()), deposit(&env, &k.pool, &f.pubkey())), (777_777, 0));
    env.ok(&[cb(300_000), deliver_ix(&stranger.pubkey(), &k, &g.pubkey(), &tg.owned)], &[&stranger]);
    assert_eq!(core_owner(&env, &tg.owned[0]), g.pubkey());
    // E sells everything: its pieces burn into the queue; a stranger reaps; no deposit moves
    let sell = peg_sell_ix(&env, &e.pubkey(), &k, coins(&env, &k, &e.pubkey()));
    env.ok(&[cb(400_000), sell], &[&e]);
    let q = queue(&env, &k);
    assert_eq!(q.len(), 2);
    env.ok(&[cb(400_000), reap_ix(&stranger.pubkey(), &k, &q)], &[&stranger]);
    assert!(q.iter().all(|a| burned(&env, a)));
    assert_eq!((deposit(&env, &k.pool, &e.pubkey()), deposit(&env, &k.pool, &g.pubkey())), (0, 777_777));
    check_books(&env, &k, &all, false, "after the upgrade");
}

// =========================================================================================
// The deposit and mint_for
// =========================================================================================

#[test]
fn r8_a_wallet_that_mints_for_itself_pays_its_pieces_once() {
    // payer == wallet: the keeper fee goes from the wallet's deposit to the wallet; what
    // wallet and deposit hold together goes down by the pieces and one signature, nothing else
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    let c = cfg(&env, &k.pool);
    let dep = sdk_deposit_for(&env, &c, 3);
    buy_with_deposit(&mut env, &w, &k, SOL, dep);
    go(&mut env, 103, 90);
    let total = |env: &Env| env.lamports(&w.pubkey()) + deposit(env, &k.pool, &w.pubkey());
    let before = total(&env);
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 3);
    env.ok(&[cb(400_000), mint_for_ix(&w.pubkey(), &k, &w.pubkey(), 0, 3)], &[&w]);
    assert_eq!(before - total(&env), cost - KEEPER_FEE + fee);
    assert!((0..3).all(|i| core_owner(&env, &asset_of(&k.pool, &w.pubkey(), i)) == w.pubkey()));
    check_books(&env, &k, &[w.pubkey()], true, "self mint");
}

#[test]
fn r8_no_keeper_fee_is_ever_paid_for_nothing() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let (a, b, c, d) = (newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m), newcomer(&mut env, &m));
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &a, &k, SOL, SOL / 10); // decided at 103
    env.ok(&[open_ticket_ix(&b.pubkey(), &k.pool), deposit_ix(&b.pubkey(), &k.pool, SOL / 10)], &[&b]); // nothing earned
    buy_with_deposit(&mut env, &d, &k, SOL, SOL / 10); // decided, then the coins leave
    go(&mut env, 102, 90);
    buy_with_deposit(&mut env, &c, &k, SOL, SOL / 10); // decided at 105
    go(&mut env, 103, 90);
    let gone = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &coins_of(&k, &d.pubkey()), &coins_of(&k, &a.pubkey()), &d.pubkey(), &[], coins(&env, &k, &d.pubkey())).unwrap();
    env.ok(&[gone], &[&d]);
    let held = |env: &Env| [&a, &b, &c, &d].map(|w| deposit(env, &k.pool, &w.pubkey()));
    let start = held(&env);
    let kb = env.lamports(&keeper.pubkey());
    for (who, w) in [("nothing earned", &b), ("not decided yet", &c), ("coins gone", &d)] {
        let e = keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 4)]).unwrap_err();
        assert!(e.contains("NothingToMint"), "{who}: {e}");
    }
    // a real mint and an empty one in one transaction: all of it fails, at most a signature
    let ixs = [cb(800_000), mint_for_ix(&keeper.pubkey(), &k, &a.pubkey(), 0, 3), mint_for_ix(&keeper.pubkey(), &k, &b.pubkey(), 0, 3)];
    refused(&mut env, &ixs, &[&keeper], &["NothingToMint"]);
    assert!(kb - env.lamports(&keeper.pubkey()) <= fee);
    assert_eq!(held(&env), start, "no deposit moved");
    assert_eq!(ticket(&env, &k.pool, &d.pubkey()).pending(), 3, "the refused call dropped nothing for good");
    check_books(&env, &k, &[a.pubkey(), b.pubkey(), c.pubkey(), d.pubkey()], true, "refusals");
}

#[test]
fn r8_a_deposit_only_ever_lands_where_its_wallet_alone_can_take_it_back() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let stranger = env.user(SOL);

    // a deposit to the wallet's ticket on a pool that does not exist (a wrong pool in a client)
    let nowhere = Pubkey::new_unique();
    env.ok(&[deposit_ix(&w.pubkey(), &nowhere, SOL / 20)], &[&w]);
    // a stranger opens that ticket: it is the wallet's, and the stranger cannot take from it
    let s0 = env.lamports(&stranger.pubkey());
    env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &nowhere, &w.pubkey())], &[&stranger]);
    assert_eq!(s0 - env.lamports(&stranger.pubkey()), fee, "the deposit paid the ticket's rent, the stranger nothing");
    assert_eq!(ticket(&env, &nowhere, &w.pubkey()).user, w.pubkey());
    let mut ix = withdraw_ix(&stranger.pubkey(), &nowhere);
    ix.accounts[1].pubkey = ticket_of(&nowhere, &w.pubkey());
    refused(&mut env, &[ix], &[&stranger], &["ConstraintSeeds"]);
    // the wallet takes it back; the ticket's rent stays locked (no instruction closes a ticket)
    let before = env.lamports(&w.pubkey());
    env.ok(&[withdraw_ix(&w.pubkey(), &nowhere)], &[&w]);
    let back = env.lamports(&w.pubkey()) + fee - before;
    assert_eq!(back, SOL / 20 - rent(&env, Ticket::space(0)));
    println!("a deposit to a wrong pool: {back} of {} lamports came back; the rest is that ticket's rent", SOL / 20);

    // the three instructions of a one-approval buy in any order: the wallet's money ends up as
    // its own deposit (less its own ticket's rent when the deposit went in before the ticket
    // was opened), the buy always earns once the ticket is open before the swap. (A deposit
    // under 890,880 lamports into an address that is not open yet fails the whole buy on a real
    // cluster: the runtime refuses to create an account under the rent of an empty one.
    // LiteSVM does not model that rule; the SDK opens the ticket first, so it never arises.)
    let need = 20_000_000u64;
    for (i, order) in [[0usize, 1, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1]].iter().enumerate() {
        let x = newcomer(&mut env, &m);
        go(&mut env, 100 + 10 * i as u64, 90);
        let parts = [open_ticket_ix(&x.pubkey(), &k.pool), buy_ix(&env, &x.pubkey(), &k, SOL), deposit_ix(&x.pubkey(), &k.pool, need)];
        let mut ixs = vec![cb(400_000)];
        ixs.extend(order.iter().map(|j| parts[*j].clone()));
        let before = env.lamports(&x.pubkey());
        env.ok(&ixs, &[&x]);
        let opened_first = order.iter().position(|j| *j == 0) < order.iter().position(|j| *j == 2);
        let t = ticket(&env, &k.pool, &x.pubkey());
        let earned = order.iter().position(|j| *j == 0) < order.iter().position(|j| *j == 1);
        assert_eq!(t.pending(), if earned { 3 } else { 0 }, "order {order:?}");
        let spent = before - env.lamports(&x.pubkey()) - fee;
        let d = deposit(&env, &k.pool, &x.pubkey());
        assert_eq!(spent, need + if opened_first { rent(&env, Ticket::space(0)) } else { 0 }, "order {order:?}");
        assert_eq!(d, need - if opened_first { 0 } else { rent(&env, Ticket::space(0)) }, "order {order:?}");
        println!("order {order:?}: earned {}, deposit {d}", t.pending());
    }
}

#[test]
fn r8_mint_for_into_a_list_near_the_cap_fits_the_heap_and_the_budget() {
    // a wallet holding 193 pieces with three decided: the keeper's mint reads and grows a
    // ticket of close to 200 entries
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, SOL, SOL / 5);
    env.mint_to(&m.authority, &m.base_mint, &coins_of(&k, &w.pubkey()), 400 * UNIT);
    // rewrite the list as 193 made-up entries (a test-only shortcut for 193 earlier mints)
    let key = ticket_of(&k.pool, &w.pubkey());
    let mut t = ticket(&env, &k.pool, &w.pubkey());
    t.owned = (0..193).map(|_| Pubkey::new_unique()).collect();
    let mut data = Vec::new();
    t.try_serialize(&mut data).unwrap();
    let mut acc = env.svm.get_account(&key).unwrap();
    acc.data = data;
    env.svm.set_account(key, acc).unwrap();
    let held = deposit(&env, &k.pool, &w.pubkey());
    go(&mut env, 103, 90);
    let cost = mint_for_cost(&env, &k.pool, &w.pubkey(), 3);
    let cu = keeper_send(&mut env, &keeper, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 3)]).unwrap();
    println!("mint_for of 3 into a list of 193 used {cu} CU");
    assert!(cu < 200_000);
    assert_eq!(held - deposit(&env, &k.pool, &w.pubkey()), cost);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).owned.len(), 196);
    assert_eq!(ticket_len(&env, &k.pool, &w.pubkey()), Ticket::space(196));
}

#[test]
fn r8_a_rich_stranger_cannot_buy_a_victims_pieces_into_another_wallet() {
    // the pieces of a ticket go to its wallet whoever pays, whatever the payer adds: a payer
    // that is also the wallet of another ticket, a payer that funds the victim's deposit, a
    // payer that pre-funds the victim's asset addresses
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let victim = newcomer(&mut env, &m);
    let rich = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &victim, &k, SOL, 0);
    buy_with_deposit(&mut env, &rich, &k, SOL, 0);
    go(&mut env, 103, 90);
    // the rich wallet pays the victim's deposit and pre-funds every asset address of the victim
    env.ok(&[system_instruction::transfer(&rich.pubkey(), &ticket_of(&k.pool, &victim.pubkey()), SOL / 10)], &[&rich]);
    for i in 0..3 {
        env.ok(&[system_instruction::transfer(&rich.pubkey(), &asset_of(&k.pool, &victim.pubkey(), i), SOL)], &[&rich]);
    }
    let held = deposit(&env, &k.pool, &victim.pubkey());
    let r0 = env.lamports(&rich.pubkey());
    let cost = mint_for_cost(&env, &k.pool, &victim.pubkey(), 3);
    env.ok(&[cb(400_000), mint_for_ix(&rich.pubkey(), &k, &victim.pubkey(), 0, 3)], &[&rich]);
    assert_eq!(env.lamports(&rich.pubkey()), r0 + KEEPER_FEE - fee, "the payer is paid back exactly; the pre-funds do not come back to it");
    assert_eq!(deposit(&env, &k.pool, &victim.pubkey()), held - cost + 3 * SOL, "the pre-funded lamports became the victim's deposit");
    for i in 0..3 {
        assert_eq!(core_owner(&env, &asset_of(&k.pool, &victim.pubkey(), i)), victim.pubkey());
    }
    // the rich wallet's own ticket is untouched and its pieces still wait for it
    assert_eq!(ticket(&env, &k.pool, &rich.pubkey()).pending(), 3);
    // and the victim alone takes the gift out
    let before = env.lamports(&victim.pubkey());
    let left = deposit(&env, &k.pool, &victim.pubkey());
    env.ok(&[withdraw_ix(&victim.pubkey(), &k.pool)], &[&victim]);
    assert_eq!(env.lamports(&victim.pubkey()), before + left - fee);
    check_books(&env, &k, &[victim.pubkey(), rich.pubkey()], true, "gifts");
}

#[test]
fn r8_send_pieces_to_a_prefunded_or_roomy_ticket_takes_no_deposit_and_charges_only_real_growth() {
    let mut env = Env::new();
    let (m, k) = plain_setup(&mut env, NAME, URI_BASE, 3);
    let fee = signature_fee(&mut env);
    let w = newcomer(&mut env, &m);
    let r1 = newcomer(&mut env, &m);
    let r2 = newcomer(&mut env, &m);
    let x = newcomer(&mut env, &m);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, 2 * SOL, 0);
    buy_with_deposit(&mut env, &r2, &k, SOL / 2, 0);
    go(&mut env, 103, 90);
    let t = ticket(&env, &k.pool, &w.pubkey());
    env.ok(&[cb(400_000), mint_ix(&w.pubkey(), &k, 3, 0, 3)], &[&w]);
    let t2 = ticket(&env, &k.pool, &r2.pubkey());
    env.ok(&[cb(400_000), mint_ix(&r2.pubkey(), &k, t2.pending() as u8, 0, t2.pending())], &[&r2]);
    assert_eq!(t.pending(), 3);
    let a: Vec<Pubkey> = ticket(&env, &k.pool, &w.pubkey()).owned.clone();
    // r2 sends its pieces away, then deposits. Since round 11 the sender's ticket shrinks to
    // its empty list and the rent of the entries that left stays in it, as r2's deposit
    // (before, a plain coin's ticket kept its length and that rent was locked).
    let r2p = ticket(&env, &k.pool, &r2.pubkey()).owned.clone();
    env.ok(&[cb(400_000), send_ix(&r2.pubkey(), &k, &x.pubkey(), &r2p)], &[&r2]);
    env.ok(&[deposit_ix(&r2.pubkey(), &k.pool, 300_000)], &[&r2]);
    let r2_len = ticket_len(&env, &k.pool, &r2.pubkey());
    let freed = rent(&env, Ticket::space(r2p.len())) - rent(&env, Ticket::space(0));
    assert_eq!((r2_len, deposit(&env, &k.pool, &r2.pubkey())), (Ticket::space(0), freed + 300_000));

    // r1 has no ticket, but sent 0.5 SOL to its address first: the send opens the ticket over it
    env.ok(&[system_instruction::transfer(&r1.pubkey(), &ticket_of(&k.pool, &r1.pubkey()), SOL / 2)], &[&r1]);
    let w0 = env.lamports(&w.pubkey());
    env.ok(&[cb(400_000), send_ix(&w.pubkey(), &k, &r1.pubkey(), &[a[2]])], &[&w]);
    assert_eq!(w0 - env.lamports(&w.pubkey()), fee, "the sender paid nothing: the receiver's own lamports already cover its ticket");
    assert_eq!(deposit(&env, &k.pool, &r1.pubkey()), SOL / 2 - rent(&env, Ticket::space(1)));
    // r2's ticket grows for what arrives: the sender pays exactly that growth, r2's deposit
    // stays. (A ticket with room for them, which only the live binaries leave behind, takes
    // them with no growth and the sender pays nothing: round11.rs checks that case.)
    let n = r2p.len().min(2);
    let w0 = env.lamports(&w.pubkey());
    env.ok(&[cb(400_000), send_ix(&w.pubkey(), &k, &r2.pubkey(), &a[..n])], &[&w]);
    assert_eq!(w0 - env.lamports(&w.pubkey()), fee + rent(&env, Ticket::space(n)) - rent(&env, Ticket::space(0)));
    assert_eq!((deposit(&env, &k.pool, &r2.pubkey()), ticket_len(&env, &k.pool, &r2.pubkey())), (freed + 300_000, Ticket::space(n)));
    for p in &a[..n] {
        assert_eq!(core_owner(&env, p), r2.pubkey());
    }
    check_books(&env, &k, &[w.pubkey(), r1.pubkey(), r2.pubkey(), x.pubkey()], true, "sends");
}

#[test]
fn r8_mint_for_at_its_limits_fits_a_wallets_budget_and_never_wraps() {
    // the longest name and address, numbers of ten digits, four pieces: compute and size
    let mut env = Env::new();
    let long_uri = format!("https://{}", "u".repeat(72));
    let (m, k) = plain_setup(&mut env, &"N".repeat(24), &long_uri, 5);
    let w = newcomer(&mut env, &m);
    let keeper = env.user(SOL);
    let set_minted = |env: &mut Env, minted: u32| {
        let key = cfg_of(&k.pool);
        let mut acc = env.svm.get_account(&key).unwrap();
        let mut c: CollectionConfig = env.account(&key);
        c.minted = minted;
        let mut data = Vec::new();
        c.try_serialize(&mut data).unwrap();
        acc.data[..data.len()].copy_from_slice(&data);
        env.svm.set_account(key, acc).unwrap();
    };
    set_minted(&mut env, u32::MAX - 10);
    go(&mut env, 100, 90);
    buy_with_deposit(&mut env, &w, &k, 2 * SOL, SOL / 10);
    assert_eq!(ticket(&env, &k.pool, &w.pubkey()).pending(), 5);
    go(&mut env, 103, 90);
    let ixs = [cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 0, 4)];
    let size = env.tx_size(&ixs, &keeper.pubkey(), 1);
    let cu = keeper_send(&mut env, &keeper, &ixs).unwrap();
    println!("mint_for of 4 pieces at the longest name and address, ten-digit numbers: {cu} CU, {size} bytes");
    assert!(cu < 200_000 && size <= 1232);
    // past u32 the call is refused, never wrapped
    set_minted(&mut env, u32::MAX);
    let before = env.svm.get_account(&ticket_of(&k.pool, &w.pubkey())).unwrap();
    refused(&mut env, &[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &w.pubkey(), 4, 1)], &[&keeper], &["ArithmeticOverflow", "overflow"]);
    refused(&mut env, &[cb(400_000), mint_ix(&w.pubkey(), &k, 1, 4, 1)], &[&w], &["overflow", "Overflow", "panicked"]);
    assert_eq!(env.svm.get_account(&ticket_of(&k.pool, &w.pubkey())).unwrap(), before, "nothing changed");
}

// =========================================================================================
// The pegged coin
// =========================================================================================

#[test]
fn r8_pegged_a_keeper_mint_between_a_wallets_transactions_never_moves_a_piece_wrongly() {
    let mut env = Env::new();
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let v = peg_wallet(&mut env, &p, true);
    let b = peg_wallet(&mut env, &p, true);
    let keeper = env.user(SOL);
    // v: three minted pieces, then a buy with a deposit whose three pieces are decided
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &v.pubkey(), &k, SOL)], &[&v]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&v.pubkey(), &k, 3, 0, 3)], &[&v]);
    go(&mut env, 110, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &v.pubkey(), &k, SOL), deposit_ix(&v.pubkey(), &k.pool, SOL / 20)], &[&v]);
    go(&mut env, 113, 90);
    let pv = ticket(&env, &k.pool, &v.pubkey()).owned.clone();
    assert_eq!((pv.len(), ticket(&env, &k.pool, &v.pubkey()).pending()), (3, 3));
    let fork = env.svm.clone();

    // 0. the reference: a stage, then the transfer, in the same slot: the staged piece travels
    env.ok(&[stage_ix(&v.pubkey(), &k, &[pv[2]])], &[&v]);
    env.ok(&[peg_transfer_ix(&k, &v.pubkey(), &b.pubkey(), UNIT)], &[&v]);
    assert_eq!(ticket(&env, &k.pool, &b.pubkey()).owned, vec![pv[2]]);

    // 1. the same, with anyone's mint_for in between: the mint cleared the stage, so the
    //    transfer carries nothing and v keeps every piece (a stage sent on its own can be
    //    voided by a mint in the same slot; nothing goes anywhere it should not)
    env.svm = fork.clone();
    env.ok(&[stage_ix(&v.pubkey(), &k, &[pv[2]])], &[&v]);
    env.ok(&[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 3, 3)], &[&keeper]);
    assert_eq!(ticket(&env, &k.pool, &v.pubkey()).staged, 0);
    env.ok(&[peg_transfer_ix(&k, &v.pubkey(), &b.pubkey(), UNIT)], &[&v]);
    assert!(ticket(&env, &k.pool, &b.pubkey()).owned.is_empty());
    assert_eq!(ticket(&env, &k.pool, &v.pubkey()).owned.len(), 6);
    check_books(&env, &k, &[v.pubkey(), b.pubkey()], true, "stage then mint_for");

    // 2. the SDK's one-transaction send, built before the keeper's mint lands: the stage
    //    names pieces that are no longer the end of the list, so the whole send fails
    env.svm = fork.clone();
    let send = |n: usize| {
        vec![
            reorder_ix(&v.pubkey(), &k, 0, n as u32 - 1),
            stage_ix(&v.pubkey(), &k, &[pv[0]]),
            peg_transfer_ix(&k, &v.pubkey(), &b.pubkey(), UNIT),
            deliver_ix(&v.pubkey(), &k, &b.pubkey(), &[pv[0]]),
        ]
    };
    let built = send(pv.len());
    env.ok(&[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 3, 3)], &[&keeper]);
    refused(&mut env, &[[cb(400_000)].to_vec(), built].concat(), &[&v], &["NotStaged"]);
    assert!(ticket(&env, &k.pool, &b.pubkey()).owned.is_empty());
    // built from a fresh read, it sends exactly the chosen piece
    let fresh = send(ticket(&env, &k.pool, &v.pubkey()).owned.len());
    env.ok(&[[cb(400_000)].to_vec(), fresh].concat(), &[&v]);
    assert_eq!(ticket(&env, &k.pool, &b.pubkey()).owned, vec![pv[0]]);
    assert_eq!(core_owner(&env, &pv[0]), b.pubkey());

    // 3. a sell of everything built before the keeper's mint: it lands, the hook burns the
    //    newest pieces (the ones just minted); its reap does not name them, so they wait in
    //    the queue for the next reaper (finding I1 for a pegged coin)
    env.svm = fork;
    let all = coins(&env, &k, &v.pubkey());
    let burn_at_build: Vec<Pubkey> = pv.iter().rev().cloned().collect();
    let sell = vec![cb(600_000), peg_sell_ix(&env, &v.pubkey(), &k, all), reap_ix(&v.pubkey(), &k, &burn_at_build)];
    let next: Vec<Pubkey> = (3..6).map(|i| asset_of(&k.pool, &v.pubkey(), i)).collect();
    let mut proposed = sell.clone();
    proposed[2] = reap_ix(&v.pubkey(), &k, &[burn_at_build.clone(), next.clone()].concat());
    let fork2 = env.svm.clone();
    env.ok(&[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 3, 3)], &[&keeper]);
    env.ok(&sell, &[&v]);
    assert!(ticket(&env, &k.pool, &v.pubkey()).owned.is_empty());
    let mut left = queue(&env, &k);
    left.sort();
    let mut want = next.clone();
    want.sort();
    assert_eq!(left, want, "the three new pieces wait in the queue for another reaper");
    // the proposed reap (the next addresses named too) burns all six in the sell
    env.svm = fork2;
    env.ok(&[cb(400_000), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 3, 3)], &[&keeper]);
    env.ok(&proposed, &[&v]);
    assert!(queue(&env, &k).is_empty());
    check_books(&env, &k, &[v.pubkey(), b.pubkey()], true, "sell after mint_for");
}

#[test]
fn r8_pegged_huge_deposits_and_a_rich_queue_never_break_a_transfer_or_move_a_deposit() {
    let mut env = Env::new();
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let fee = signature_fee(&mut env);
    let a = peg_wallet(&mut env, &p, true);
    let b = peg_wallet(&mut env, &p, true);
    let stranger = env.user(SOL);
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &a.pubkey(), &k, SOL)], &[&a]);
    go(&mut env, 103, 90);
    env.ok(&[cb(400_000), mint_ix(&a.pubkey(), &k, 3, 0, 3)], &[&a]);
    let sell = peg_sell_ix(&env, &a.pubkey(), &k, coins(&env, &k, &a.pubkey()) - 3 * UNIT);
    env.ok(&[cb(400_000), sell], &[&a]);
    // a 1,000 SOL deposit at the sender, 500 at the receiver, 5 SOL lying in the queue
    let bump = |env: &mut Env, key: Pubkey, extra: u64| {
        let mut acc = env.svm.get_account(&key).unwrap();
        acc.lamports += extra;
        env.svm.set_account(key, acc).unwrap();
    };
    bump(&mut env, ticket_of(&k.pool, &a.pubkey()), 1_000 * SOL);
    bump(&mut env, ticket_of(&k.pool, &b.pubkey()), 500 * SOL);
    bump(&mut env, queue_of(&k.pool), 5 * SOL);
    let piece = rent(&env, Ticket::space(1)) - rent(&env, Ticket::space(0));

    // one unit to b: a piece moves, b's ticket grows on a's freed rent, both deposits stay
    env.ok(&[peg_transfer_ix(&k, &a.pubkey(), &b.pubkey(), UNIT)], &[&a]);
    assert_eq!(ticket(&env, &k.pool, &b.pubkey()).owned.len(), 1);
    assert_eq!((deposit(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &b.pubkey())), (1_000 * SOL, 500 * SOL));
    // a sells the rest: two pieces burn; the queue pays its own growth from what lies in it,
    // so a's ticket keeps the rent it freed (the queue is nobody's, as before round 8)
    let sell = peg_sell_ix(&env, &a.pubkey(), &k, coins(&env, &k, &a.pubkey()));
    env.ok(&[cb(400_000), sell], &[&a]);
    assert_eq!(queue(&env, &k).len(), 2);
    assert_eq!(deposit(&env, &k.pool, &a.pubkey()), 1_000 * SOL + 2 * piece);
    // a stranger reaps: it gets the assets' rent and what lay in the queue; no deposit moves
    let q = queue(&env, &k);
    let s0 = env.lamports(&stranger.pubkey());
    env.ok(&[cb(400_000), reap_ix(&stranger.pubkey(), &k, &q)], &[&stranger]);
    assert!(env.lamports(&stranger.pubkey()) + fee - s0 > 5 * SOL - 2 * piece);
    assert_eq!((deposit(&env, &k.pool, &a.pubkey()), deposit(&env, &k.pool, &b.pubkey())), (1_000 * SOL + 2 * piece, 500 * SOL));
    // b sends its piece on to a wallet without a ticket: it burns; b's deposit stays
    let c = peg_wallet(&mut env, &p, false);
    env.ok(&[peg_transfer_ix(&k, &b.pubkey(), &c.pubkey(), coins(&env, &k, &b.pubkey()))], &[&b]);
    assert_eq!(deposit(&env, &k.pool, &b.pubkey()), 500 * SOL);
    // and each wallet takes exactly its own
    for (w, amount) in [(&a, 1_000 * SOL + 2 * piece), (&b, 500 * SOL)] {
        let before = env.lamports(&w.pubkey());
        env.ok(&[withdraw_ix(&w.pubkey(), &k.pool)], &[w]);
        assert_eq!(env.lamports(&w.pubkey()), before + amount - fee);
    }
    check_books(&env, &k, &[a.pubkey(), b.pubkey(), c.pubkey()], false, "huge deposits");
}

#[test]
fn r8_pegged_one_approval_buy_mint_for_and_a_transfer_in_one_transaction_keep_the_peg() {
    // whatever a stranger packs into one transaction around a wallet's pieces, the wallet's
    // pieces stay backed and in its hands: its buy with a deposit, then anyone's mint_for
    // and a transfer out by the wallet in one transaction
    let mut env = Env::new();
    let p = peg_setup(&mut env, 3);
    let k = p.k.clone();
    let v = peg_wallet(&mut env, &p, true);
    let b = peg_wallet(&mut env, &p, true);
    let keeper = env.user(SOL);
    go(&mut env, 100, 90);
    env.ok(&[cb(400_000), peg_buy_ix(&env, &v.pubkey(), &k, SOL), deposit_ix(&v.pubkey(), &k.pool, SOL / 20)], &[&v]);
    go(&mut env, 103, 90);
    // v sends all but one unit away and, in the same transaction, the keeper mints
    let out = coins(&env, &k, &v.pubkey()) - UNIT;
    let ixs = [cb(600_000), peg_transfer_ix(&k, &v.pubkey(), &b.pubkey(), out), mint_for_ix(&keeper.pubkey(), &k, &v.pubkey(), 0, 3)];
    env.ok(&ixs, &[&keeper, &v]);
    let t = ticket(&env, &k.pool, &v.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (1, 0), "only what one unit backs was minted");
    assert_eq!(core_owner(&env, &t.owned[0]), v.pubkey());
    assert!(ticket(&env, &k.pool, &b.pubkey()).owned.is_empty(), "waiting pieces never travel");
    check_books(&env, &k, &[v.pubkey(), b.pubkey()], true, "one transaction");
}
