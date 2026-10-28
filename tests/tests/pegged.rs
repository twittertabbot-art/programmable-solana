//! The pegged coin: a Token-2022 mint whose transfer hook is the collectible program.
//! Every transfer of the coin moves or burns the pieces in the same instruction, the way
//! Unipeg's token contract does on Ethereum: a plain wallet transfer carries the piece to
//! the receiver, a sell burns it, and no watcher is needed for either.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hook_collectible::{QUEUE_SEED, Q_COUNT, Q_ENTRIES, SLOT_HASHES_ID, VALIDATION_SEED};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_account::Account;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_sha256_hasher::hashv;
use solana_signer::Signer;
use solana_slot_hashes::SlotHashes;

const DECIMALS: u8 = 6;
const BASE_LIQ: u64 = 1_000_000_000_000; // 1M coins
const QUOTE_LIQ: u64 = 100 * SOL;
/// 2,000 coins per piece: a 1 SOL buy (about 9,870 coins) earns 4, capped at 3 per buy.
const UNIT: u64 = 2_000 * 1_000_000;
const ART: [u8; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

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
    ata_with(wallet, &k.base_mint, &TOKEN_2022)
}

/// What the coin's transfer hook needs in any transfer from `from` to `to`: the config,
/// both wallets' tickets, the burn queue, the hook's account list.
fn hook_metas(k: &PoolKeys, from: &Pubkey, to: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(cfg_of(&k.pool), false),
        AccountMeta::new(ticket_of(&k.pool, from), false),
        AccountMeta::new(ticket_of(&k.pool, to), false),
        AccountMeta::new(queue_of(&k.pool), false),
        AccountMeta::new_readonly(validation_of(&k.base_mint), false),
    ]
}
/// The pool's hook as `user` sees it: the callback's three accounts, then what the coin's
/// transfer hook needs for a transfer between `user` and the vault (owned by the pool).
fn hook_for(k: &PoolKeys, user: &Pubkey) -> HookRef {
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

fn block_hash(slot: u64) -> [u8; 32] {
    hashv(&[b"block", &slot.to_le_bytes()]).to_bytes()
}
fn go(env: &mut Env, slot: u64) {
    env.svm.warp_to_slot(slot);
    let v: Vec<(u64, Hash)> = (slot.saturating_sub(20)..slot).map(|s| (s, Hash::new_from_array(block_hash(s)))).collect();
    env.svm.set_sysvar(&SlotHashes::new(&v));
}

/// A Token-2022 mint with a transfer hook. `hook` and `hook_authority` as given.
fn create_hooked_mint(env: &mut Env, payer: &Keypair, hook: Option<Pubkey>, hook_authority: Option<Pubkey>) -> Keypair {
    let mint = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[t22::extension::ExtensionType::TransferHook]).unwrap();
    let ixs = [
        system_instruction::create_account(&payer.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::extension::transfer_hook::instruction::initialize(&TOKEN_2022, &mint.pubkey(), hook_authority, hook).unwrap(),
        t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &payer.pubkey(), None, DECIMALS).unwrap(),
    ];
    env.ok(&ixs, &[payer, &mint]);
    mint
}
fn mint_coins(env: &mut Env, authority: &Keypair, mint: &Pubkey, to: &Pubkey, amount: u64) {
    let ata = ata_with(to, mint, &TOKEN_2022);
    let ixs = [
        Env::create_ata_with_ix(&authority.pubkey(), to, mint, &TOKEN_2022),
        t22::instruction::mint_to(&TOKEN_2022, mint, &ata, &authority.pubkey(), &[], amount).unwrap(),
    ];
    env.ok(&ixs, &[authority]);
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
            args: hook_collectible::InitCollectionArgs { name: "Pegs".into(), uri_base: "https://example.com/art".into(), unit: UNIT, max_supply, max_per_buy, art: ART },
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
    for i in 0..n {
        accounts.push(AccountMeta::new(asset_of(&k.pool, user, first_index + i), false));
    }
    Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::Mint { count }.data() }
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
/// Stage the pieces named. They must be the end of the wallet's list, in list order.
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
/// A plain Token-2022 transfer between two wallets' associated token accounts, the way a
/// wallet's Send button builds it: TransferChecked plus the hook's accounts.
fn transfer_ix(k: &PoolKeys, from: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
    let mut ix = t22::instruction::transfer_checked(&TOKEN_2022, &coins_of(k, from), &k.base_mint, &coins_of(k, to), from, &[], amount, DECIMALS).unwrap();
    ix.accounts.extend(hook_metas(k, from, to));
    ix.accounts.push(AccountMeta::new_readonly(pid(), false));
    ix
}

struct World {
    env: Env,
    k: PoolKeys,
    creator: Keypair,
    authority: Keypair,
}

/// A pegged coin with its pool, at slot 50.
fn world(max_supply: u32, max_per_buy: u8) -> World {
    let mut env = Env::new();
    let authority = env.user(10 * SOL);
    let creator = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&creator, &creator.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 10_000 * SOL);
    go(&mut env, 50);

    // the coin: Token-2022, the collectible program as its transfer hook, no hook authority
    let mint = create_hooked_mint(&mut env, &creator, Some(pid()), None);
    mint_coins(&mut env, &creator, &mint.pubkey(), &creator.pubkey(), 10 * BASE_LIQ);
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    // config, then the coin is bound to it; the mint signs
    let ixs = [compute_budget_ix(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, max_supply, max_per_buy), init_peg_ix(&creator.pubkey(), &k)];
    env.ok(&ixs, &[&creator, &mint]);
    let hook = hook_for(&k, &creator.pubkey());
    let ix = env.create_pool_ix(&creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(500_000), ix], &[&creator]);
    World { env, k, creator, authority }
}

impl World {
    /// A wallet with SOL to trade, a token account for the coin and, if asked, a ticket.
    fn wallet(&mut self, ticket: bool) -> Keypair {
        let w = self.env.user(5 * SOL);
        let q = self.env.create_ata(&w, &w.pubkey(), &self.k.quote_mint);
        self.env.mint_to(&self.authority, &self.k.quote_mint, &q, 50 * SOL);
        self.env.ok(&[Env::create_ata_with_ix(&w.pubkey(), &w.pubkey(), &self.k.base_mint, &TOKEN_2022)], &[&w]);
        if ticket {
            self.env.ok(&[open_ticket_ix(&w.pubkey(), &self.k.pool)], &[&w]);
        }
        w
    }
    fn cfg(&self) -> hook_collectible::CollectionConfig {
        self.env.account(&cfg_of(&self.k.pool))
    }
    fn ticket(&self, user: &Pubkey) -> hook_collectible::Ticket {
        self.env.account(&ticket_of(&self.k.pool, user))
    }
    fn coins(&self, wallet: &Pubkey) -> u64 {
        self.env.balance(&coins_of(&self.k, wallet))
    }
    fn queue(&self) -> Vec<Pubkey> {
        let d = self.env.svm.get_account(&queue_of(&self.k.pool)).unwrap().data;
        let n = u32::from_le_bytes(d[Q_COUNT..Q_COUNT + 4].try_into().unwrap()) as usize;
        assert_eq!(d.len(), Q_ENTRIES + 32 * n, "the queue account is exactly as long as its entries");
        (0..n).map(|i| Pubkey::new_from_array(d[Q_ENTRIES + 32 * i..Q_ENTRIES + 32 * (i + 1)].try_into().unwrap())).collect()
    }
    fn buy(&mut self, user: &Keypair, amount: u64) -> u64 {
        let hook = hook_for(&self.k, &user.pubkey());
        let ix = self.env.swap_ix(&user.pubkey(), &self.k, &hook, DIRECTION_BUY, amount, 0);
        self.env.send(&[compute_budget_ix(400_000), ix], &[user]).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs())).compute_units_consumed
    }
    fn sell_ix(&self, user: &Pubkey, amount: u64) -> Instruction {
        let hook = hook_for(&self.k, user);
        self.env.swap_ix(user, &self.k, &hook, DIRECTION_SELL, amount, 0)
    }
    fn sell_down_to(&mut self, user: &Keypair, keep: u64) -> u64 {
        let ix = self.sell_ix(&user.pubkey(), self.coins(&user.pubkey()) - keep);
        self.env.send(&[compute_budget_ix(400_000), ix], &[user]).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs())).compute_units_consumed
    }
    /// Buy at `slot`, then mint what it earned three slots later.
    fn buy_and_mint(&mut self, user: &Keypair, slot: u64, amount: u64) {
        go(&mut self.env, slot);
        self.buy(user, amount);
        go(&mut self.env, slot + 3);
        let t = self.ticket(&user.pubkey());
        let n = t.pending();
        self.env.ok(&[compute_budget_ix(400_000), mint_ix(&user.pubkey(), &self.k, n as u8, t.minted, n)], &[user]);
    }
    fn assets(&self, user: &Pubkey, n: u32) -> Vec<Pubkey> {
        (0..n).map(|i| asset_of(&self.k.pool, user, i)).collect()
    }
    fn core_owner(&self, asset: &Pubkey) -> Pubkey {
        Pubkey::new_from_array(self.env.svm.get_account(asset).unwrap().data[1..33].try_into().unwrap())
    }
    fn burned(&self, asset: &Pubkey) -> bool {
        let a = self.env.svm.get_account(asset).expect("the address stays taken");
        a.data.len() == 1 && a.data[0] == 0
    }
    fn transfer(&mut self, from: &Keypair, to: &Pubkey, amount: u64) -> u64 {
        let ix = transfer_ix(&self.k, &from.pubkey(), to, amount);
        self.env.send(&[ix], &[from]).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs())).compute_units_consumed
    }
}

#[test]
fn the_pool_trades_a_pegged_coin_and_a_buy_earns_pieces() {
    let mut w = world(1_000, 3);
    let c = w.cfg();
    assert!(c.pegged);
    assert_eq!((c.base_mint, c.token_program), (w.k.base_mint, TOKEN_2022));
    assert_eq!(w.env.pool(&w.k.pool).base_token_program, TOKEN_2022);
    assert_eq!(w.coins(&w.k.pool), 0);
    assert_eq!(w.env.balance(&w.k.base_vault), BASE_LIQ, "the creator's coins reached the vault through the hook");

    let t = w.wallet(true);
    go(&mut w.env, 100);
    let cu = w.buy(&t, SOL);
    println!("buy of a pegged coin used {cu} CU");
    assert!(w.coins(&t.pubkey()) > 4 * UNIT);
    assert_eq!(w.ticket(&t.pubkey()).pending(), 3, "the pool's callback recorded what the buy earned");
    go(&mut w.env, 103);
    w.env.ok(&[compute_budget_ix(400_000), mint_ix(&t.pubkey(), &w.k, 3, 0, 3)], &[&t]);
    let a = w.assets(&t.pubkey(), 3);
    assert_eq!(w.ticket(&t.pubkey()).owned, a);
    assert_eq!(w.cfg().live, 3);
    assert!(w.queue().is_empty());
}

#[test]
fn a_plain_transfer_carries_the_piece_to_the_receiver() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL);
    let pieces = w.assets(&a.pubkey(), 3);
    w.sell_down_to(&a, 3 * UNIT + 7); // three units, three pieces, a little change

    // sending less than what is above the peg moves nothing
    w.transfer(&a, &b.pubkey(), 7);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&b.pubkey()).owned.len()), (3, 0));

    // one unit leaves: the last piece of the list goes with it, in the same transfer
    let cu = w.transfer(&a, &b.pubkey(), UNIT);
    println!("plain transfer that moves one piece used {cu} CU");
    assert_eq!(w.ticket(&a.pubkey()).owned, vec![pieces[0], pieces[1]]);
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[2]]);
    assert_eq!(w.cfg().live, 3, "moved, not burned");
    assert!(w.queue().is_empty());

    // the Metaplex asset follows: anyone delivers it to its new holder
    assert_eq!(w.core_owner(&pieces[2]), a.pubkey());
    let stranger = w.env.user(SOL);
    w.env.ok(&[compute_budget_ix(300_000), deliver_ix(&stranger.pubkey(), &w.k, &b.pubkey(), &[pieces[2], pieces[0]])], &[&stranger]);
    assert_eq!(w.core_owner(&pieces[2]), b.pubkey());
    assert_eq!(w.core_owner(&pieces[0]), a.pubkey(), "a piece that is not in that wallet's list is left alone");
    // delivering again is a no-op
    w.env.ok(&[compute_budget_ix(300_000), deliver_ix(&stranger.pubkey(), &w.k, &b.pubkey(), &[pieces[2]])], &[&stranger]);

    // the wallet chooses what travels: it puts its first piece last, then sends two units
    w.env.ok(&[reorder_ix(&a.pubkey(), &w.k, 0, 1)], &[&a]);
    w.transfer(&a, &b.pubkey(), 2 * UNIT);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 0);
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[2], pieces[0], pieces[1]], "last of the sender's list first");

    // and the receiver sends one on, as the holder it now is
    let c = w.wallet(true);
    w.transfer(&b, &c.pubkey(), UNIT);
    assert_eq!(w.ticket(&c.pubkey()).owned, vec![pieces[1]]);
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[2], pieces[0]]);
}

#[test]
fn a_transfer_to_a_wallet_without_a_ticket_burns_the_piece() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let nobody = w.wallet(false);
    w.buy_and_mint(&a, 100, SOL);
    let pieces = w.assets(&a.pubkey(), 3);
    w.sell_down_to(&a, 3 * UNIT);

    let cu = w.transfer(&a, &nobody.pubkey(), 2 * UNIT);
    println!("plain transfer that burns two pieces used {cu} CU");
    assert_eq!(w.ticket(&a.pubkey()).owned, vec![pieces[0]]);
    assert_eq!(w.queue(), vec![pieces[2], pieces[1]], "queued in the order they left the list");
    assert_eq!(w.cfg().live, 1, "they stopped existing in the transfer itself");
    assert!(w.env.svm.get_account(&ticket_of(&w.k.pool, &nobody.pubkey())).map(|x| x.data.is_empty()).unwrap_or(true));

    // the Metaplex assets are burned by whoever reaps, and that pays
    let stranger = w.env.user(SOL);
    let before = w.env.lamports(&stranger.pubkey());
    // a piece that is not in the queue is skipped, not burned
    w.env.ok(&[compute_budget_ix(300_000), reap_ix(&stranger.pubkey(), &w.k, &[pieces[0], pieces[1]])], &[&stranger]);
    assert!(w.burned(&pieces[1]) && !w.burned(&pieces[0]) && !w.burned(&pieces[2]));
    assert_eq!(w.queue(), vec![pieces[2]]);
    w.env.ok(&[compute_budget_ix(300_000), reap_ix(&stranger.pubkey(), &w.k, &[pieces[2]])], &[&stranger]);
    assert!(w.burned(&pieces[2]));
    assert!(w.queue().is_empty());
    assert!(w.env.lamports(&stranger.pubkey()) > before, "the rent of the burned pieces pays the reaper");

    // opening the receiver's ticket first makes the same transfer carry the piece
    let friend = w.wallet(false);
    w.env.ok(&[open_ticket_for_ix(&a.pubkey(), &w.k.pool, &friend.pubkey())], &[&a]);
    w.transfer(&a, &friend.pubkey(), UNIT);
    assert_eq!(w.ticket(&friend.pubkey()).owned, vec![pieces[0]]);
    assert_eq!(w.cfg().live, 1);
}

#[test]
fn a_sell_burns_in_the_swap_itself() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL);
    let pieces = w.assets(&a.pubkey(), 3);

    // down to one unit: two pieces leave the list inside the swap, with no settle
    let cu = w.sell_down_to(&a, UNIT);
    println!("sell of a pegged coin that burns two pieces used {cu} CU");
    assert_eq!(w.ticket(&a.pubkey()).owned, vec![pieces[0]]);
    assert_eq!(w.queue(), vec![pieces[2], pieces[1]]);
    assert_eq!(w.cfg().live, 1);
    // nothing is left for a settle to do
    let stranger = w.env.user(SOL);
    w.env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &w.k, &a.pubkey(), &[pieces[0]])], &[&stranger]);
    assert!(!w.burned(&pieces[0]));

    // the way the site sells: the swap and the reap of what it burns, one transaction
    let ixs = [compute_budget_ix(500_000), w.sell_ix(&a.pubkey(), UNIT), reap_ix(&a.pubkey(), &w.k, &[pieces[0], pieces[1], pieces[2]])];
    let meta = w.env.ok(&ixs, &[&a]);
    println!("sell + reap of three used {} CU", meta.compute_units_consumed);
    assert!(pieces.iter().all(|p| w.burned(p)));
    assert!(w.queue().is_empty());
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.cfg().live), (0, 0));

    // and the wallet buys and mints again afterwards
    w.buy_and_mint(&a, 120, SOL);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 3);
}

#[test]
fn waiting_pieces_are_dropped_first_and_the_receiver_takes_only_what_it_can_back() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL); // 3 minted
    go(&mut w.env, 110);
    w.buy(&a, SOL); // 3 waiting
    let pieces = w.assets(&a.pubkey(), 3);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&a.pubkey()).pending(), w.cfg().reserved_pending), (3, 3, 3));

    // leave four units: the two newest waiting pieces go, the minted ones stay
    let have = w.coins(&a.pubkey());
    w.transfer(&a, &b.pubkey(), have - 4 * UNIT);
    let t = w.ticket(&a.pubkey());
    assert_eq!((t.owned.len(), t.pending(), t.rolls), (3, 1, 6));
    assert_eq!(w.cfg().reserved_pending, 1);
    assert_eq!(w.ticket(&b.pubkey()).owned.len(), 0, "waiting pieces are dropped, they do not travel");

    // b now holds a lot of coins and no piece. a sends half a unit: one waiting piece and
    // nothing else is above the peg
    w.transfer(&a, &b.pubkey(), UNIT / 2);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&a.pubkey()).pending()), (3, 0));

    // a receiver with room for one takes one; the rest burns
    let c = w.wallet(true);
    let have = w.coins(&a.pubkey());
    // c will hold 1.5 units: room for one piece. a keeps nothing.
    w.transfer(&a, &b.pubkey(), have - (UNIT + UNIT / 2));
    assert_eq!(w.ticket(&a.pubkey()).owned, vec![pieces[0]], "b took the two that left: it had the coins for them");
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[2], pieces[1]]);
    let b_all = w.coins(&b.pubkey());
    w.transfer(&b, &c.pubkey(), b_all - UNIT / 2); // b keeps half a unit: both its pieces leave, c backs many
    assert_eq!(w.ticket(&c.pubkey()).owned, vec![pieces[1], pieces[2]]);
    w.transfer(&a, &c.pubkey(), UNIT + UNIT / 2);
    assert_eq!(w.ticket(&c.pubkey()).owned, vec![pieces[1], pieces[2], pieces[0]]);
    assert_eq!(w.cfg().live, 3);
}

#[test]
fn a_full_receiver_takes_none_and_the_rest_burns() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL);
    w.buy_and_mint(&b, 110, SOL);
    let pa = w.assets(&a.pubkey(), 3);
    w.sell_down_to(&a, 3 * UNIT);
    w.sell_down_to(&b, 3 * UNIT);
    // b holds three pieces on exactly three units. One more unit arrives: room for one.
    // a sends two units: one piece moves, one burns.
    w.transfer(&a, &b.pubkey(), UNIT);
    assert_eq!(w.ticket(&b.pubkey()).owned.len(), 4);
    assert_eq!(w.ticket(&b.pubkey()).owned[3], pa[2]);
    let c = w.wallet(true);
    w.transfer(&b, &c.pubkey(), UNIT / 2); // b: 3.5 units, 4 pieces: one above the peg, c: 0.5 units, no room
    assert_eq!(w.ticket(&b.pubkey()).owned.len(), 3);
    assert_eq!(w.queue(), vec![pa[2]]);
    assert_eq!(w.cfg().live, 5);
}

#[test]
fn only_the_token_program_reaches_the_hook() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL);
    // somebody calls execute directly with real accounts, hoping to strip a's pieces
    let stranger = w.env.user(SOL);
    let mut accounts = vec![
        AccountMeta::new_readonly(coins_of(&w.k, &a.pubkey()), false),
        AccountMeta::new_readonly(w.k.base_mint, false),
        AccountMeta::new_readonly(coins_of(&w.k, &b.pubkey()), false),
        AccountMeta::new_readonly(stranger.pubkey(), true),
        AccountMeta::new_readonly(validation_of(&w.k.base_mint), false),
    ];
    accounts.extend(vec![
        AccountMeta::new(cfg_of(&w.k.pool), false),
        AccountMeta::new(ticket_of(&w.k.pool, &a.pubkey()), false),
        AccountMeta::new(ticket_of(&w.k.pool, &b.pubkey()), false),
        AccountMeta::new(queue_of(&w.k.pool), false),
    ]);
    let mut data = hook_collectible::EXECUTE_DISC.to_vec();
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    w.env.err(&[Instruction { program_id: pid(), accounts, data }], &[&stranger], "only the token program calls this");
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 3);
}

#[test]
fn only_the_creator_of_the_coin_binds_it_and_only_once() {
    let mut env = Env::new();
    let authority = env.user(10 * SOL);
    let creator = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    go(&mut env, 50);

    // a plain SPL coin cannot be bound
    let plain = Keypair::new();
    let ixs = [
        system_instruction::create_account(&creator.pubkey(), &plain.pubkey(), env.svm.minimum_balance_for_rent_exemption(82), 82, &TOKEN),
        anchor_spl::token::spl_token::instruction::initialize_mint2(&TOKEN, &plain.pubkey(), &creator.pubkey(), None, DECIMALS).unwrap(),
    ];
    env.ok(&ixs, &[&creator, &plain]);
    let k = Env::pool_keys(&plain.pubkey(), &quote);
    env.ok(&[compute_budget_ix(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, 100, 3)], &[&creator]);
    env.err(&[init_peg_ix(&creator.pubkey(), &k)], &[&creator, &plain], "whose transfer hook is this program");

    // nor a coin whose hook could still be pointed somewhere else
    let loose = create_hooked_mint(&mut env, &creator, Some(pid()), Some(creator.pubkey()));
    let k = Env::pool_keys_with(&loose.pubkey(), &quote, &TOKEN_2022);
    env.ok(&[compute_budget_ix(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, 100, 3)], &[&creator]);
    env.err(&[init_peg_ix(&creator.pubkey(), &k)], &[&creator, &loose], "whose transfer hook is this program");

    // the real one: the mint has to sign, and the config has to be the caller's own
    let mint = create_hooked_mint(&mut env, &creator, Some(pid()), None);
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    env.ok(&[compute_budget_ix(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, 100, 3)], &[&creator]);
    let mut unsigned = init_peg_ix(&creator.pubkey(), &k);
    unsigned.accounts[1].is_signer = false;
    assert!(env.send(&[unsigned], &[&creator]).is_err(), "without the mint's signature nobody binds the coin");
    let squatter = env.user(SOL);
    env.err(&[init_peg_ix(&squatter.pubkey(), &k)], &[&squatter, &mint], "not created by the pool creator");
    // a config of another pool cannot take this coin
    let other_quote = env.create_mint(&authority, 9);
    let other = Env::pool_keys_with(&mint.pubkey(), &other_quote, &TOKEN_2022);
    let mut wrong = init_peg_ix(&creator.pubkey(), &k);
    wrong.accounts[2].pubkey = other_quote;
    env.err(&[wrong], &[&creator, &mint], "does not belong to this pool");
    let _ = other;

    env.ok(&[init_peg_ix(&creator.pubkey(), &k)], &[&creator, &mint]);
    assert!(env.send(&[init_peg_ix(&creator.pubkey(), &k)], &[&creator, &mint]).is_err(), "bound once");
}

#[test]
fn a_coin_with_a_transfer_hook_trades_only_in_its_own_pool() {
    let mut env = Env::new();
    let authority = env.user(10 * SOL);
    let creator = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&creator, &creator.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 10_000 * SOL);
    go(&mut env, 50);
    let mint = create_hooked_mint(&mut env, &creator, Some(pid()), None);
    mint_coins(&mut env, &creator, &mint.pubkey(), &creator.pubkey(), 10 * BASE_LIQ);
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    env.ok(&[compute_budget_ix(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k.pool, 100, 3), init_peg_ix(&creator.pubkey(), &k)], &[&creator, &mint]);

    // no hook on the pool, or another hook: the pool refuses the coin
    let ix = env.create_pool_ix(&creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    env.err(&[compute_budget_ix(500_000), ix], &[&creator], "extension");
    let tax = env.tax_hook(&creator, &creator, &k.pool, &quote, &creator.pubkey(), 100, 100, 500);
    let ix = env.create_pool_ix(&creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &tax);
    env.err(&[compute_budget_ix(500_000), ix], &[&creator], "extension");

    // a second pool of the same coin, against another quote, with a config of its own:
    // the collectible hook refuses, a pegged coin has one pool
    let quote2 = env.create_mint(&authority, 9);
    let q2 = env.create_ata(&creator, &creator.pubkey(), &quote2);
    env.mint_to(&authority, &quote2, &q2, 10_000 * SOL);
    let k2 = Env::pool_keys_with(&mint.pubkey(), &quote2, &TOKEN_2022);
    env.ok(&[compute_budget_ix(300_000), init_config_ix(&creator.pubkey(), &creator.pubkey(), &k2.pool, 100, 3)], &[&creator]);
    let mut hook2 = hook_for(&k2, &creator.pubkey());
    // the coin's transfer still needs the accounts of the pool it is bound to
    hook2.extra.extend(hook_metas(&k, &creator.pubkey(), &k2.pool));
    let ix = env.create_pool_ix(&creator.pubkey(), &k2, 30, BASE_LIQ, QUOTE_LIQ, &hook2);
    env.err(&[compute_budget_ix(500_000), ix], &[&creator], "trades in one pool only");

    // the bound pool works
    let ix = env.create_pool_ix(&creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook_for(&k, &creator.pubkey()));
    env.ok(&[compute_budget_ix(500_000), ix], &[&creator]);
}

#[test]
fn the_explicit_send_is_refused_and_settle_still_catches_what_no_transfer_shows() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL);
    let pieces = w.assets(&a.pubkey(), 3);

    // send_pieces is the plain coin's way; here the transfer itself carries the piece
    let mut accounts = hook_collectible::accounts::SendPieces {
        user: a.pubkey(),
        cfg: cfg_of(&w.k.pool),
        ticket: ticket_of(&w.k.pool, &a.pubkey()),
        to: b.pubkey(),
        to_ticket: ticket_of(&w.k.pool, &b.pubkey()),
        mint: w.k.base_mint,
        from_coins: coins_of(&w.k, &a.pubkey()),
        to_coins: coins_of(&w.k, &b.pubkey()),
        token_program: TOKEN_2022,
        collection: collection_of(&w.k.pool),
        collection_authority: authority_of(&w.k.pool),
        core_program: MPL_CORE,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.push(AccountMeta::new(pieces[2], false));
    let ix = Instruction { program_id: pid(), accounts, data: hook_collectible::instruction::SendPieces {}.data() };
    w.env.err(&[compute_budget_ix(400_000), ix], &[&a], "carries its pieces in a plain transfer");

    // burning coins is not a transfer: the hook never runs, the wallet ends above the peg
    let have = w.coins(&a.pubkey());
    let burn = t22::instruction::burn(&TOKEN_2022, &coins_of(&w.k, &a.pubkey()), &w.k.base_mint, &a.pubkey(), &[], have - 2 * UNIT).unwrap();
    w.env.ok(&[burn], &[&a]);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 3);
    // settle is still there for that, for anyone
    let stranger = w.env.user(SOL);
    w.env.ok(&[compute_budget_ix(300_000), settle_ix(&stranger.pubkey(), &w.k, &a.pubkey(), &[pieces[2], pieces[1]])], &[&stranger]);
    assert!(w.burned(&pieces[2]) && !w.burned(&pieces[1]));
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.cfg().live), (2, 2));
}

#[test]
fn protocol_fees_in_the_coin_are_collected_through_the_hook() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL);
    w.sell_down_to(&a, UNIT);
    let fees = w.env.pool(&w.k.pool).protocol_fees_base;
    assert!(fees > 0);
    let treasury = w.env.treasury.pubkey();
    let mut ix = w.env.collect_ix(&a.pubkey(), &w.k);
    // vault to the treasury's token account: the hook's accounts for that transfer, and the hook program
    ix.accounts.extend(hook_metas(&w.k, &w.k.pool, &treasury));
    ix.accounts.push(AccountMeta::new_readonly(pid(), false));
    w.env.ok(&[compute_budget_ix(400_000), ix], &[&a]);
    assert_eq!(w.env.balance(&ata_with(&treasury, &w.k.base_mint, &TOKEN_2022)), fees);
}

// ---- through the launchpad -------------------------------------------------------------------

const SUPPLY: u64 = 1_000_000_000_000_000; // 1B at 6 decimals

/// The pegged coin the way the SDK creates it: the mint, its name written by the token
/// program itself and made final, then the supply and the end of the mint authority.
fn create_pegged_token_ixs(dev: &Pubkey, mint: &Pubkey) -> Vec<Instruction> {
    use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
    use anchor_spl::token_2022_extensions::spl_token_metadata_interface::instruction as md;
    let (name, symbol, uri) = ("Programmable", "SHOT", "https://example.invalid/meta.json");
    let metadata_len = (4 + 32 + 32 + 4 + name.len() + 4 + symbol.len() + 4 + uri.len() + 4) as u16;
    let dev_ata = ata_with(dev, mint, &TOKEN_2022);
    vec![
        Instruction {
            program_id: hooklaunch::ID,
            accounts: hooklaunch::accounts::CreatePeggedMint {
                dev: *dev,
                mint: *mint,
                dev_ata,
                hook_program: pid(),
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hooklaunch::instruction::CreatePeggedMint { decimals: DECIMALS, metadata_len }.data(),
        },
        md::initialize(&TOKEN_2022, mint, dev, mint, dev, name.into(), symbol.into(), uri.into()),
        md::update_authority(&TOKEN_2022, mint, dev, OptionalNonZeroPubkey::default()),
        Instruction {
            program_id: hooklaunch::ID,
            accounts: hooklaunch::accounts::FinishPeggedToken { dev: *dev, mint: *mint, dev_ata, token_program: TOKEN_2022 }.to_account_metas(None),
            data: hooklaunch::instruction::FinishPeggedToken { total_supply: SUPPLY }.data(),
        },
    ]
}

fn launch_ix(env: &Env, dev: &Pubkey, k: &PoolKeys, hook: &HookRef, args: hooklaunch::LaunchArgs) -> Instruction {
    let launch = Pubkey::find_program_address(&[hooklaunch::LAUNCH_SEED, k.base_mint.as_ref()], &hooklaunch::ID).0;
    let mut accounts = hooklaunch::accounts::LaunchPool {
        dev: *dev,
        platform: env.platform,
        treasury: env.treasury.pubkey(),
        launch,
        base_mint: k.base_mint,
        quote_mint: k.quote_mint,
        pool: k.pool,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        lp_mint: k.lp_mint,
        lp_lock: k.lp_lock,
        dev_base: ata_with(dev, &k.base_mint, &k.base_program),
        dev_quote: ata(dev, &k.quote_mint),
        dev_lp: ata(dev, &k.lp_mint),
        hook_program: hook.program,
        hook_program_data: hook.program_data(),
        hook_manifest: hook.manifest(),
        hook_extra_metas: hook.extra_metas(),
        hook_quote_treasury: ata(dev, &k.quote_mint),
        hook_caller: hook.caller(),
        hookpool_program: hookpool::ID,
        hookpool_event_authority: event_authority_address(&hookpool::ID),
        base_token_program: k.base_program,
        quote_token_program: TOKEN,
        token_program: TOKEN,
        associated_token_program: ATA_PROGRAM,
        system_program: system_program::ID,
        event_authority: event_authority_address(&hooklaunch::ID),
        program: hooklaunch::ID,
    }
    .to_account_metas(None);
    accounts.extend(hook.extra.iter().cloned());
    Instruction { program_id: hooklaunch::ID, accounts, data: hooklaunch::instruction::Launch { args }.data() }
}

#[test]
fn the_launchpad_launches_a_pegged_coin() {
    let mut env = Env::new();
    let authority = env.user(10 * SOL);
    let dev = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&dev, &dev.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 1_000 * SOL);
    go(&mut env, 50);

    // transaction 1: the coin, its config, the binding, the dev's ticket
    let mint = Keypair::new();
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    // the supply cannot be minted while the coin has no name, or while the name can still change
    let steps = create_pegged_token_ixs(&dev.pubkey(), &mint.pubkey());
    env.err(&[compute_budget_ix(500_000), steps[0].clone(), steps[3].clone()], &[&dev, &mint], "no name yet");
    env.err(&[compute_budget_ix(500_000), steps[0].clone(), steps[1].clone(), steps[3].clone()], &[&dev, &mint], "still has an update authority");
    let mut ixs = vec![compute_budget_ix(500_000)];
    ixs.extend(steps);
    ixs.extend([init_config_ix(&dev.pubkey(), &dev.pubkey(), &k.pool, 10_000, 3), init_peg_ix(&dev.pubkey(), &k), open_ticket_ix(&dev.pubkey(), &k.pool)]);
    let meta = env.ok(&ixs, &[&dev, &mint]);
    println!("create transaction is {} bytes", env.tx_size(&ixs, &dev.pubkey(), 2));
    println!("create a pegged coin used {} CU", meta.compute_units_consumed);
    assert_eq!(env.balance(&ata_with(&dev.pubkey(), &mint.pubkey(), &TOKEN_2022)), SUPPLY);
    let m = env.svm.get_account(&mint.pubkey()).unwrap();
    assert_eq!(m.owner, TOKEN_2022);
    assert_eq!(u32::from_le_bytes(m.data[0..4].try_into().unwrap()), 0, "no mint authority");
    let text = String::from_utf8_lossy(&m.data);
    assert!(text.contains("Programmable") && text.contains("SHOT") && text.contains("https://example.invalid/meta.json"), "name, symbol and uri live in the mint");

    // transaction 2: the launch, with a first buy by the dev, through three programs deep
    let hook = hook_for(&k, &dev.pubkey());
    let args = hooklaunch::LaunchArgs { lp_fee_bps: 100, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: SOL / 2, min_dev_buy_out: 1 };
    let meta = env.ok(&[compute_budget_ix(800_000), launch_ix(&env, &dev.pubkey(), &k, &hook, args)], &[&dev]);
    println!("launch of a pegged coin with a dev buy used {} CU", meta.compute_units_consumed);
    let pool = env.pool(&k.pool);
    assert_eq!((pool.hook_program, pool.hook_kind, pool.base_token_program), (pid(), HOOK_KIND_PLATFORM, TOKEN_2022));
    let c: hook_collectible::CollectionConfig = env.account(&cfg_of(&k.pool));
    assert!(c.pegged && c.base_mint == mint.pubkey());
    let t: hook_collectible::Ticket = env.account(&ticket_of(&k.pool, &dev.pubkey()));
    assert_eq!(t.pending(), 3, "the dev's first buy earned pieces like anyone's");

    // a stranger buys, mints, and sends a unit to a friend with a ticket: the piece travels
    let mut w = World { env, k, creator: dev, authority };
    let a = w.wallet(true);
    let b = w.wallet(true);
    let unit_buy = 3 * SOL;
    w.buy_and_mint(&a, 100, unit_buy);
    let n = w.ticket(&a.pubkey()).owned.len();
    assert!(n >= 1);
    let last = *w.ticket(&a.pubkey()).owned.last().unwrap();
    let keep = (n as u64 - 1) * UNIT;
    let have = w.coins(&a.pubkey());
    w.transfer(&a, &b.pubkey(), have - keep);
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![last]);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), n - 1);
    let _ = &w.creator;
}

#[test]
fn a_chosen_piece_travels_with_exactly_its_coins() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL); // about 4.9 units, three pieces: nearly two units to spare
    let pieces = w.assets(&a.pubkey(), 3);
    let (a0, b0) = (w.coins(&a.pubkey()), w.coins(&b.pubkey()));

    // one unit alone moves nothing: a's coins still back all three
    w.transfer(&a, &b.pubkey(), UNIT);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&b.pubkey()).owned.len()), (3, 0));
    w.transfer(&b, &a.pubkey(), UNIT);

    // the holder picks its first piece: puts it last, stages one, sends one unit. One transaction.
    let ixs = [
        reorder_ix(&a.pubkey(), &w.k, 0, 2),
        stage_ix(&a.pubkey(), &w.k, &[pieces[0]]),
        transfer_ix(&w.k, &a.pubkey(), &b.pubkey(), UNIT),
        deliver_ix(&a.pubkey(), &w.k, &b.pubkey(), &[pieces[0]]),
    ];
    let meta = w.env.ok(&ixs, &[&a]);
    println!("send one chosen piece with its unit used {} CU", meta.compute_units_consumed);
    assert_eq!(w.ticket(&a.pubkey()).owned, vec![pieces[1], pieces[2]]);
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[0]]);
    assert_eq!(w.core_owner(&pieces[0]), b.pubkey());
    assert_eq!((w.coins(&a.pubkey()), w.coins(&b.pubkey())), (a0 - UNIT, b0 + UNIT), "exactly one unit travelled");
    assert_eq!(w.ticket(&a.pubkey()).staged, 0, "the stage is spent");

    // a stage does not survive its slot: the next transfer, later, moves nothing
    w.env.ok(&[stage_ix(&a.pubkey(), &w.k, &[pieces[2]])], &[&a]);
    go(&mut w.env, 200);
    w.transfer(&a, &b.pubkey(), UNIT);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 2);
    w.transfer(&b, &a.pubkey(), UNIT);

    // a staged piece travels with a whole unit: a quarter of one carries nothing
    w.env.ok(&[stage_ix(&a.pubkey(), &w.k, &[pieces[2]]), transfer_ix(&w.k, &a.pubkey(), &b.pubkey(), UNIT / 4)], &[&a]);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&a.pubkey()).staged), (2, 0));

    // a stage never reaches the pool: a sell in the same slot burns nothing that is backed
    let keep = w.coins(&a.pubkey()) - UNIT / 4;
    let ixs = [stage_ix(&a.pubkey(), &w.k, &[pieces[1], pieces[2]]), compute_budget_ix(400_000), w.sell_ix(&a.pubkey(), UNIT / 4)];
    w.env.ok(&ixs, &[&a]);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.coins(&a.pubkey())), (2, keep));
    assert!(w.queue().is_empty());

    // staged to a wallet with no ticket: the piece stays where its coins are, nothing burns
    let nobody = w.wallet(false);
    go(&mut w.env, 210);
    let ixs = [stage_ix(&a.pubkey(), &w.k, &[pieces[2]]), transfer_ix(&w.k, &a.pubkey(), &nobody.pubkey(), UNIT)];
    w.env.ok(&ixs, &[&a]);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 2);
    assert!(w.queue().is_empty());

    // nobody stages for somebody else, more than it holds, or above the peg
    let stranger = w.env.user(SOL);
    assert!(w.env.send(&[stage_ix(&stranger.pubkey(), &w.k, &[pieces[2]])], &[&stranger]).is_err());
    w.env.err(&[stage_ix(&a.pubkey(), &w.k, &[pieces[0], pieces[1], pieces[2]])], &[&a], "between 1 and 4");
}

// ---- review round 3: the findings of the independent review of the pegged coin -------------

#[test]
fn a_dust_transfer_cannot_push_pieces_into_another_wallet() {
    // Finding: the receiver's room was its whole free backing, and a staged piece travelled
    // with any amount. A stranger could fill another wallet's list for one raw coin, and the
    // victim's next sell then dropped its own waiting pieces instead.
    let mut w = world(1_000, 3);
    let x = w.wallet(true);
    let v = w.wallet(true);
    w.buy_and_mint(&x, 100, SOL); // x: three pieces on about 4.9 units
    go(&mut w.env, 110);
    w.buy(&v, 13 * SOL / 10); // v: more than six units, three waiting pieces
    let px = w.assets(&x.pubkey(), 3);
    assert_eq!((w.ticket(&v.pubkey()).owned.len(), w.ticket(&v.pubkey()).pending()), (0, 3));
    assert!(w.coins(&v.pubkey()) / UNIT >= 6 && w.coins(&v.pubkey()) % UNIT < UNIT - 2);

    // staged pieces and one raw coin: a staged piece travels with a whole unit, so none does
    w.env.ok(&[stage_ix(&x.pubkey(), &w.k, &px), transfer_ix(&w.k, &x.pubkey(), &v.pubkey(), 1)], &[&x]);
    assert_eq!(w.ticket(&x.pubkey()).owned, px);
    assert_eq!(w.ticket(&x.pubkey()).staged, 0);
    assert_eq!(w.ticket(&v.pubkey()).owned.len(), 0);

    // an unbacked piece and one raw coin: it adds no whole unit to v, so the piece burns
    w.sell_down_to(&x, 3 * UNIT);
    w.transfer(&x, &v.pubkey(), 1);
    assert_eq!(w.ticket(&x.pubkey()).owned, vec![px[0], px[1]]);
    assert_eq!(w.queue(), vec![px[2]]);
    let t = w.ticket(&v.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (0, 3), "v's list and its waiting pieces are untouched");

    // v sells down to three units: its own three waiting pieces are what they back
    w.sell_down_to(&v, 3 * UNIT + 5);
    let t = w.ticket(&v.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (0, 3));

    // a whole unit carries one piece, and brings the coins that back it
    w.transfer(&x, &v.pubkey(), UNIT);
    let t = w.ticket(&v.pubkey());
    assert_eq!((t.owned.clone(), t.pending()), (vec![px[1]], 3));
    assert_eq!(w.coins(&v.pubkey()) / UNIT, 4);
    assert_eq!(w.ticket(&x.pubkey()).owned, vec![px[0]]);
}

#[test]
fn a_stage_names_its_pieces_and_fails_when_the_list_changed() {
    // Finding: a send was "move index 0 to the end, stage one". A piece that reached the
    // list before the send landed travelled in place of the chosen one.
    let mut w = world(1_000, 3);
    let v = w.wallet(true);
    let x = w.wallet(true);
    let buyer = w.wallet(true);
    w.buy_and_mint(&v, 100, SOL);
    w.buy_and_mint(&x, 110, SOL);
    let pv = w.assets(&v.pubkey(), 3);
    let px = w.assets(&x.pubkey(), 3);

    // v's send of its first piece, built on the list [pv0, pv1, pv2]
    let send = [reorder_ix(&v.pubkey(), &w.k, 0, 2), stage_ix(&v.pubkey(), &w.k, &[pv[0]]), transfer_ix(&w.k, &v.pubkey(), &buyer.pubkey(), UNIT)];
    // before it lands, x gives v a piece together with its unit
    w.env.ok(&[stage_ix(&x.pubkey(), &w.k, &[px[2]]), transfer_ix(&w.k, &x.pubkey(), &v.pubkey(), UNIT)], &[&x]);
    assert_eq!(w.ticket(&v.pubkey()).owned, vec![pv[0], pv[1], pv[2], px[2]]);
    // v's send would now carry x's piece. It fails, and nothing moves.
    w.env.err(&send, &[&v], "the list changed");
    assert_eq!(w.ticket(&buyer.pubkey()).owned.len(), 0);
    assert_eq!(w.ticket(&v.pubkey()).owned, vec![pv[0], pv[1], pv[2], px[2]]);

    // built again on the list as it is, it carries the chosen piece
    let again = [reorder_ix(&v.pubkey(), &w.k, 0, 3), stage_ix(&v.pubkey(), &w.k, &[pv[0]]), transfer_ix(&w.k, &v.pubkey(), &buyer.pubkey(), UNIT)];
    w.env.ok(&again, &[&v]);
    assert_eq!(w.ticket(&buyer.pubkey()).owned, vec![pv[0]]);
    assert_eq!(w.ticket(&v.pubkey()).owned, vec![pv[1], pv[2], px[2]]);

    // the names are checked in list order, and their number is the count
    w.env.err(&[stage_ix(&v.pubkey(), &w.k, &[px[2], pv[2]])], &[&v], "the list changed");
    w.env.ok(&[stage_ix(&v.pubkey(), &w.k, &[pv[2], px[2]])], &[&v]);
    assert_eq!(w.ticket(&v.pubkey()).staged, 2);
}

#[test]
fn a_staged_send_keeps_the_senders_waiting_pieces() {
    // Finding: the hook dropped waiting pieces before it counted the staged pieces that
    // were about to leave, so a send cost the sender a waiting piece its coins still backed.
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL); // three minted
    go(&mut w.env, 110);
    w.buy(&a, SOL); // three waiting
    w.sell_down_to(&a, 6 * UNIT); // exactly six units for three minted and three waiting
    let pieces = w.assets(&a.pubkey(), 3);
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&a.pubkey()).pending()), (3, 3));

    w.env.ok(&[stage_ix(&a.pubkey(), &w.k, &[pieces[2]]), transfer_ix(&w.k, &a.pubkey(), &b.pubkey(), UNIT)], &[&a]);
    let t = w.ticket(&a.pubkey());
    assert_eq!((t.owned.clone(), t.pending()), (vec![pieces[0], pieces[1]], 3), "five units back two minted and three waiting");
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[2]]);
    assert_eq!(w.cfg().reserved_pending, 3);

    // staged, and more coins than the staged piece's unit: what the rest no longer backs goes as before
    let ixs = [stage_ix(&a.pubkey(), &w.k, &[pieces[1]]), transfer_ix(&w.k, &a.pubkey(), &b.pubkey(), 3 * UNIT)];
    w.env.ok(&ixs, &[&a]);
    let t = w.ticket(&a.pubkey());
    // two units left: the staged piece travelled, two waiting pieces were dropped, one minted and one waiting stay
    assert_eq!((t.owned.clone(), t.pending()), (vec![pieces[0]], 1));
    assert_eq!(w.ticket(&b.pubkey()).owned, vec![pieces[2], pieces[1]]);
    assert_eq!((w.cfg().reserved_pending, w.cfg().live), (1, 3));
}

#[test]
fn a_full_burn_queue_never_blocks_a_transfer_or_a_sell() {
    // Finding: the burn queue was one account without a ceiling. At the account size limit
    // every transfer or sell that had to burn a piece failed inside the hook.
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let nobody = w.wallet(false);
    w.buy_and_mint(&a, 100, SOL);
    let pieces = w.assets(&a.pubkey(), 3);
    w.sell_down_to(&a, 3 * UNIT);

    // the queue at its ceiling (state injected: burned pieces nobody reaped)
    let key = queue_of(&w.k.pool);
    let acc = w.env.svm.get_account(&key).unwrap();
    let full = hook_collectible::MAX_QUEUE;
    let mut data = acc.data.clone();
    data.resize(Q_ENTRIES + 32 * full, 7);
    data[Q_COUNT..Q_COUNT + 4].copy_from_slice(&(full as u32).to_le_bytes());
    let lamports = w.env.svm.minimum_balance_for_rent_exemption(data.len());
    w.env.svm.set_account(key, Account { lamports, data, owner: acc.owner, executable: false, rent_epoch: acc.rent_epoch }).unwrap();

    // a transfer that should burn a piece goes through; the piece waits on the list, above the peg
    let cu = w.transfer(&a, &nobody.pubkey(), UNIT);
    println!("plain transfer against a full burn queue used {cu} CU");
    assert_eq!(w.ticket(&a.pubkey()).owned, pieces);
    assert_eq!(w.cfg().live, 3);
    // so does a sell
    w.sell_down_to(&a, UNIT);
    assert_eq!(w.ticket(&a.pubkey()).owned, pieces);
    assert_eq!(w.env.svm.get_account(&key).unwrap().data.len(), Q_ENTRIES + 32 * full, "the queue did not grow");

    // anyone's settle burns what the coins no longer back, as on a plain coin
    let keeper = w.env.user(SOL);
    w.env.ok(&[compute_budget_ix(400_000), settle_ix(&keeper.pubkey(), &w.k, &a.pubkey(), &[pieces[2], pieces[1]])], &[&keeper]);
    assert_eq!(w.ticket(&a.pubkey()).owned, vec![pieces[0]]);
    assert!(w.burned(&pieces[2]) && w.burned(&pieces[1]));
    assert_eq!(w.cfg().live, 1);
}

#[test]
fn a_stage_is_spent_by_whatever_the_wallet_transfers_first() {
    // Finding: a sell, or a transfer out of another account of the wallet, left the stage
    // armed for the wallet's next transfer in the same slot.
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    w.buy_and_mint(&a, 100, SOL); // about 4.9 units, three pieces
    let pieces = w.assets(&a.pubkey(), 3);

    // a sell spends it
    w.env.ok(&[stage_ix(&a.pubkey(), &w.k, &[pieces[2]]), compute_budget_ix(400_000), w.sell_ix(&a.pubkey(), UNIT / 8)], &[&a]);
    assert_eq!(w.ticket(&a.pubkey()).staged, 0);
    w.transfer(&a, &b.pubkey(), UNIT); // same slot: nothing is staged any more, and its coins still back all three
    assert_eq!((w.ticket(&a.pubkey()).owned.len(), w.ticket(&b.pubkey()).owned.len()), (3, 0));

    // a transfer out of another token account of the wallet spends it too
    let aux = aux_account(&mut w.env, &a, &a.pubkey(), &w.k.base_mint);
    w.env.ok(&[transfer_between(&w.k, &coins_of(&w.k, &a.pubkey()), &a.pubkey(), &aux, &a.pubkey(), &a.pubkey(), UNIT / 8)], &[&a]);
    let ixs = [
        stage_ix(&a.pubkey(), &w.k, &[pieces[2]]),
        transfer_between(&w.k, &aux, &a.pubkey(), &coins_of(&w.k, &b.pubkey()), &b.pubkey(), &a.pubkey(), UNIT / 16),
    ];
    w.env.ok(&ixs, &[&a]);
    assert_eq!(w.ticket(&a.pubkey()).staged, 0);
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 3);
}

#[test]
fn the_launchpad_refuses_a_hidden_supply_and_a_name_that_can_still_change() {
    let mut env = Env::new();
    let authority = env.user(10 * SOL);
    let dev = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&dev, &dev.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 1_000 * SOL);
    go(&mut env, 50);

    // Finding: between the two steps the dev is the mint authority. Coins minted there made
    // the supply larger than the one the second step states.
    let mint = Keypair::new();
    let dev_ata = ata_with(&dev.pubkey(), &mint.pubkey(), &TOKEN_2022);
    let steps = create_pegged_token_ixs(&dev.pubkey(), &mint.pubkey());
    let sneak = t22::instruction::mint_to(&TOKEN_2022, &mint.pubkey(), &dev_ata, &dev.pubkey(), &[], 9 * SUPPLY).unwrap();
    let ixs = [compute_budget_ix(500_000), steps[0].clone(), steps[1].clone(), steps[2].clone(), sneak, steps[3].clone()];
    env.err(&ixs, &[&dev, &mint], "already exist");

    // Finding: with the second step skipped (supply minted and the mint authority dropped by
    // hand) the coin reached `launch` with a name its dev could rewrite afterwards.
    let mint = Keypair::new();
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    let dev_ata = ata_with(&dev.pubkey(), &mint.pubkey(), &TOKEN_2022);
    let steps = create_pegged_token_ixs(&dev.pubkey(), &mint.pubkey());
    let ixs = [
        compute_budget_ix(500_000),
        steps[0].clone(),
        steps[1].clone(),
        t22::instruction::mint_to(&TOKEN_2022, &mint.pubkey(), &dev_ata, &dev.pubkey(), &[], SUPPLY).unwrap(),
        t22::instruction::set_authority(&TOKEN_2022, &mint.pubkey(), None, t22::instruction::AuthorityType::MintTokens, &dev.pubkey(), &[]).unwrap(),
        init_config_ix(&dev.pubkey(), &dev.pubkey(), &k.pool, 10_000, 3),
        init_peg_ix(&dev.pubkey(), &k),
        open_ticket_ix(&dev.pubkey(), &k.pool),
    ];
    env.ok(&ixs, &[&dev, &mint]);
    let hook = hook_for(&k, &dev.pubkey());
    let args = hooklaunch::LaunchArgs { lp_fee_bps: 100, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: 0, min_dev_buy_out: 0 };
    env.err(&[compute_budget_ix(800_000), launch_ix(&env, &dev.pubkey(), &k, &hook, args)], &[&dev], "still has an update authority");
}

// ---- a random walk over every instruction, with the invariants checked after each step ----
// Written by the independent review; kept as a permanent test.

fn try_send(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair]) -> (bool, u64, String) {
    match env.send(ixs, signers) {
        Ok(m) => (true, m.compute_units_consumed, String::new()),
        Err(e) => (false, e.meta.compute_units_consumed, format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))),
    }
}

/// A token account of the coin that is NOT the wallet's associated one.
fn aux_account(env: &mut Env, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let acc = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Account>(&[t22::extension::ExtensionType::TransferHookAccount]).unwrap();
    let ixs = [
        system_instruction::create_account(&payer.pubkey(), &acc.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::instruction::initialize_account3(&TOKEN_2022, &acc.pubkey(), mint, owner).unwrap(),
    ];
    env.ok(&ixs, &[payer, &acc]);
    acc.pubkey()
}

/// TransferChecked between two arbitrary token accounts, with the hook accounts for their owners.
fn transfer_between(k: &PoolKeys, src: &Pubkey, src_owner: &Pubkey, dst: &Pubkey, dst_owner: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut ix = t22::instruction::transfer_checked(&TOKEN_2022, src, &k.base_mint, dst, authority, &[], amount, DECIMALS).unwrap();
    ix.accounts.extend(hook_metas(k, src_owner, dst_owner));
    ix.accounts.push(AccountMeta::new_readonly(pid(), false));
    ix
}

fn reveal_ix(payer: &Pubkey, k: &PoolKeys, user: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::Reveal { payer: *payer, ticket: ticket_of(&k.pool, user), slot_hashes: SLOT_HASHES_ID }.to_account_metas(None),
        data: hook_collectible::instruction::Reveal {}.data(),
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn has_ticket(w: &World, wallet: &Pubkey) -> bool {
    w.env.svm.get_account(&ticket_of(&w.k.pool, wallet)).map(|a| !a.data.is_empty()).unwrap_or(false)
}

/// `above[i]`: wallet i may hold more pieces than its coins back right now (it burned coins
/// with the token program, or bought into a token account that is not its associated one).
fn check_invariants(w: &World, wallets: &[Keypair], above: &[bool], max_supply: u32, step: usize, what: &str) {
    let cfg = w.cfg();
    let mut all: Vec<Pubkey> = vec![];
    let (mut live, mut pending) = (0u32, 0u32);
    let mut everyone: Vec<(Pubkey, bool)> = wallets.iter().enumerate().map(|(i, k)| (k.pubkey(), above[i])).collect();
    everyone.push((w.k.pool, false));
    for (i, (key, may_be_above)) in everyone.iter().enumerate() {
        if !has_ticket(w, key) {
            continue;
        }
        let raw = w.env.svm.get_account(&ticket_of(&w.k.pool, key)).unwrap();
        let t = w.ticket(key);
        assert!(raw.data.len() >= hook_collectible::Ticket::space(t.owned.len()), "step {step} {what}: ticket {i} shorter than its list");
        assert!(raw.lamports >= w.env.svm.minimum_balance_for_rent_exemption(raw.data.len()), "step {step} {what}: ticket {i} below rent");
        live += t.owned.len() as u32;
        pending += t.pending();
        all.extend(t.owned.iter());
        if !may_be_above {
            let coins = if *key == w.k.pool { 0 } else { w.coins(key) };
            assert!(t.pieces() <= coins / UNIT, "step {step} {what}: wallet {i} holds {} pieces on {} units", t.pieces(), coins / UNIT);
        }
        assert!(t.pieces() <= 200);
    }
    let q = w.queue();
    assert_eq!(cfg.live, live, "step {step} {what}: live");
    assert_eq!(cfg.reserved_pending, pending, "step {step} {what}: reserved_pending");
    assert!(cfg.live + cfg.reserved_pending <= max_supply, "step {step} {what}: above max supply");
    for a in all.iter().chain(q.iter()) {
        let acc = w.env.svm.get_account(a).unwrap_or_else(|| panic!("step {step} {what}: piece without an asset"));
        assert!(acc.data.len() > 33 && acc.data[0] == 1, "step {step} {what}: a listed or queued piece has no live asset");
    }
    all.extend(q);
    let n = all.len();
    all.sort();
    all.dedup();
    assert_eq!(n, all.len(), "step {step} {what}: a piece is in two places");
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
fn withdraw_ix(user: &Pubkey, k: &PoolKeys) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_collectible::accounts::WithdrawDeposit { user: *user, ticket: ticket_of(&k.pool, user) }.to_account_metas(None),
        data: hook_collectible::instruction::WithdrawDeposit {}.data(),
    }
}
/// A wallet's deposit: what its ticket holds above the rent of its size.
fn deposit_of(w: &World, wallet: &Pubkey) -> u64 {
    let a = w.env.svm.get_account(&ticket_of(&w.k.pool, wallet)).expect("a ticket");
    a.lamports - w.env.svm.minimum_balance_for_rent_exemption(a.data.len())
}

fn random_walk(seed: u64, steps: usize, max_supply: u32, deposits: bool) {
    let mut rng = Rng(seed);
    let mut w = world(max_supply, 3);
    let n = 5usize;
    let mut wallets = vec![];
    let mut aux = vec![];
    for i in 0..n + 1 {
        let k = w.wallet(i < n); // the last wallet has no ticket
        aux.push(aux_account(&mut w.env, &k, &k.pubkey(), &w.k.base_mint));
        wallets.push(k);
    }
    let stranger = w.env.user(50 * SOL);
    w.env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &w.k.pool, &w.k.pool)], &[&stranger]);
    // round 8: a keeper that mints for the wallets out of their deposits, and what each
    // wallet's deposit is known to be
    let keeper = w.env.user(10 * SOL);
    let fee = {
        let before = w.env.lamports(&keeper.pubkey());
        w.env.ok(&[compute_budget_ix(10_000)], &[&keeper]);
        before - w.env.lamports(&keeper.pubkey())
    };
    let mut dep = vec![0u64; n + 1];
    let (mut minted_for, mut deposited) = (0u32, 0u32);
    let mut above = vec![false; n + 1];
    let mut slot = 100u64;
    let mut counts = std::collections::BTreeMap::<&str, (u32, u32)>::new();
    let (mut travelled, mut burned_in_transfers) = (0usize, 0usize);
    for step in 0..steps {
        slot += 1 + rng.below(2);
        go(&mut w.env, slot);
        let i = rng.below((n + 1) as u64) as usize;
        let j = rng.below((n + 1) as u64) as usize;
        let me = wallets[i].insecure_clone();
        let mk = me.pubkey();
        let other = wallets[j].pubkey();
        let bal = w.coins(&mk);
        let ticket = if has_ticket(&w, &mk) { Some(w.ticket(&mk)) } else { None };
        let amounts = [0u64, 1, UNIT / 2, UNIT, UNIT, 2 * UNIT + 5, 3 * UNIT, UNIT + 1, bal / 2, bal];
        let amount = amounts[rng.below(amounts.len() as u64) as usize].min(bal);
        let op = rng.below(if deposits { 20 } else { 16 });
        let keeper_before = w.env.lamports(&keeper.pubkey());
        let (what, ok): (&str, bool) = match op {
            0 | 1 | 2 => {
                let hook = hook_for(&w.k, &mk);
                let sol = [SOL / 3, SOL, 2 * SOL][rng.below(3) as usize];
                // sometimes the coins go to the non-associated account
                let mut ix = w.env.swap_ix(&mk, &w.k, &hook, DIRECTION_BUY, sol, 0);
                let to_aux = rng.below(4) == 0;
                if to_aux {
                    for m in ix.accounts.iter_mut() {
                        if m.pubkey == coins_of(&w.k, &mk) {
                            m.pubkey = aux[i];
                        }
                    }
                }
                let ok = try_send(&mut w.env, &[compute_budget_ix(400_000), ix], &[&me]).0;
                if ok && to_aux {
                    // waiting pieces earned on coins that are not in the associated account:
                    // above the peg until a mint, a settle or the next transfer
                    above[i] = true;
                }
                ("buy", ok)
            }
            3 | 14 | 15 => {
                let Some(t) = &ticket else { continue };
                let c = t.pending().min(4);
                if c == 0 {
                    continue;
                }
                ("mint", try_send(&mut w.env, &[compute_budget_ix(800_000), mint_ix(&mk, &w.k, c as u8, t.minted, c)], &[&me]).0)
            }
            4 | 5 | 6 => {
                if i == j {
                    continue;
                }
                // a plain transfer between associated accounts, sometimes staged
                let mut ixs = vec![];
                if let Some(t) = &ticket {
                    if !above[i] && !t.owned.is_empty() && rng.below(2) == 0 {
                        let c = 1 + rng.below(t.owned.len().min(8) as u64) as usize;
                        ixs.push(stage_ix(&mk, &w.k, &t.owned[t.owned.len() - c..]));
                    }
                }
                ixs.push(transfer_ix(&w.k, &mk, &other, amount));
                let before = (w.queue().len(), if has_ticket(&w, &other) { w.ticket(&other).owned.len() } else { 0 });
                let (ok, _, log) = try_send(&mut w.env, &ixs, &[&me]);
                assert!(ok, "step {step}: a plain transfer failed\n{log}");
                burned_in_transfers += w.queue().len() - before.0;
                travelled += if has_ticket(&w, &other) { w.ticket(&other).owned.len() } else { 0 } - before.1;
                above[i] = false;
                ("transfer", ok)
            }
            7 => {
                // to a non-associated account: the wallet's own, or the other wallet's
                let (dst, dst_owner) = if rng.below(2) == 0 { (aux[i], mk) } else { (aux[j], other) };
                let ix = transfer_between(&w.k, &coins_of(&w.k, &mk), &mk, &dst, &dst_owner, &mk, amount);
                let (ok, _, log) = try_send(&mut w.env, &[ix], &[&me]);
                assert!(ok, "step {step}: a transfer to a non-associated account failed\n{log}");
                above[i] = false;
                ("to-aux", ok)
            }
            8 => {
                // out of the non-associated account, to an associated one
                let have = w.env.balance(&aux[i]);
                let ix = transfer_between(&w.k, &aux[i], &mk, &coins_of(&w.k, &other), &other, &mk, have / 2);
                let (ok, _, log) = try_send(&mut w.env, &[ix], &[&me]);
                assert!(ok, "step {step}: a transfer from a non-associated account failed\n{log}");
                ("from-aux", ok)
            }
            9 => {
                if amount < UNIT / 4 {
                    continue;
                }
                let mut ixs = vec![compute_budget_ix(400_000)];
                if let Some(t) = &ticket {
                    if !above[i] && !t.owned.is_empty() && rng.below(3) == 0 {
                        let c = t.owned.len().min(3);
                        ixs.push(stage_ix(&mk, &w.k, &t.owned[t.owned.len() - c..]));
                    }
                }
                ixs.push(w.sell_ix(&mk, amount));
                let (ok, _, log) = try_send(&mut w.env, &ixs, &[&me]);
                assert!(ok, "step {step}: a sell failed\n{log}");
                above[i] = false;
                ("sell", ok)
            }
            10 => {
                if amount == 0 {
                    continue;
                }
                let ix = t22::instruction::burn(&TOKEN_2022, &coins_of(&w.k, &mk), &w.k.base_mint, &mk, &[], amount.min(UNIT + 3)).unwrap();
                let ok = try_send(&mut w.env, &[ix], &[&me]).0;
                if ok {
                    above[i] = true;
                }
                ("token-burn", ok)
            }
            11 => {
                let Some(t) = &ticket else { continue };
                let tail: Vec<Pubkey> = t.owned.iter().rev().take(12).cloned().collect();
                let ok = try_send(&mut w.env, &[compute_budget_ix(1_000_000), settle_ix(&stranger.pubkey(), &w.k, &mk, &tail)], &[&stranger]).0;
                if ok {
                    above[i] = w.ticket(&mk).pieces() > w.coins(&mk) / UNIT;
                }
                ("settle", ok)
            }
            12 => {
                let Some(t) = &ticket else { continue };
                if t.owned.len() < 2 {
                    let ok = try_send(&mut w.env, &[reveal_ix(&stranger.pubkey(), &w.k, &mk)], &[&stranger]).0;
                    ("reveal", ok)
                } else {
                    let a = rng.below(t.owned.len() as u64) as u32;
                    let b = rng.below(t.owned.len() as u64) as u32;
                    ("reorder", try_send(&mut w.env, &[reorder_ix(&mk, &w.k, a, b)], &[&me]).0)
                }
            }
            16 => {
                // a deposit: a plain transfer to the wallet's own ticket
                if ticket.is_none() {
                    continue;
                }
                let lamports = [1u64, 100_000, 3_000_000, 12_000_000][rng.below(4) as usize];
                let ok = try_send(&mut w.env, &[system_instruction::transfer(&mk, &ticket_of(&w.k.pool, &mk), lamports)], &[&me]).0;
                if ok {
                    dep[i] += lamports;
                    deposited += 1;
                }
                ("deposit", ok)
            }
            17 => {
                if ticket.is_none() || dep[i] == 0 {
                    continue;
                }
                let before = w.env.lamports(&mk);
                let held = deposit_of(&w, &mk);
                let ok = try_send(&mut w.env, &[withdraw_ix(&mk, &w.k)], &[&me]).0;
                assert!(ok, "step {step}: the wallet's own withdraw failed");
                assert_eq!(w.env.lamports(&mk), before + held - fee, "step {step}: the whole deposit went to the wallet");
                ("withdraw", ok)
            }
            18 | 19 => {
                // the keeper mints the wallet's decided pieces, paid by its deposit; half the
                // time the wallet tops its deposit up first, as a buy with a deposit does
                let Some(t) = &ticket else { continue };
                let c = t.pending().min(4);
                if c == 0 {
                    continue;
                }
                if rng.below(2) == 0 {
                    w.env.ok(&[system_instruction::transfer(&mk, &ticket_of(&w.k.pool, &mk), 20_000_000)], &[&me]);
                    deposited += 1;
                }
                let (ok, _, log) = try_send(&mut w.env, &[compute_budget_ix(800_000), mint_for_ix(&keeper.pubkey(), &w.k, &mk, t.minted, c)], &[&keeper]);
                if ok {
                    assert_eq!(w.env.lamports(&keeper.pubkey()), keeper_before + hook_collectible::KEEPER_FEE - fee, "step {step}: the keeper is paid what it spent plus the fee");
                    minted_for += 1;
                } else {
                    // the only refusals: nothing decided yet, or a deposit that does not cover it
                    assert!(log.contains("NothingToMint") || log.contains("DepositTooSmall"), "step {step}: mint_for failed for another reason\n{log}");
                }
                ("mint_for", ok)
            }
            _ => {
                // deliver what this wallet holds, reap what is queued
                let mut ixs = vec![compute_budget_ix(1_400_000)];
                if let Some(t) = &ticket {
                    if !t.owned.is_empty() {
                        let some: Vec<Pubkey> = t.owned.iter().take(6).cloned().collect();
                        ixs.push(deliver_ix(&stranger.pubkey(), &w.k, &mk, &some));
                    }
                }
                let q = w.queue();
                if !q.is_empty() {
                    let some: Vec<Pubkey> = q.iter().take(6).cloned().collect();
                    ixs.push(reap_ix(&stranger.pubkey(), &w.k, &some));
                }
                let (ok, _, log) = try_send(&mut w.env, &ixs, &[&stranger]);
                assert!(ok, "step {step}: deliver or reap failed\n{log}");
                ("deliver+reap", ok)
            }
        };
        let e = counts.entry(what).or_insert((0, 0));
        if ok {
            e.0 += 1;
        } else {
            e.1 += 1;
        }
        check_invariants(&w, &wallets, &above, max_supply, step, what);
        if deposits {
            // a deposit never pays for anyone else and never goes to a caller: it only goes
            // down through the wallet's own mint, a mint for it, or its own withdraw
            for (x, k) in wallets.iter().enumerate() {
                if !has_ticket(&w, &k.pubkey()) {
                    continue;
                }
                let now = deposit_of(&w, &k.pubkey());
                let own = x == i && matches!(what, "mint" | "mint_for" | "withdraw");
                assert!(own || now >= dep[x], "step {step} {what}: wallet {x}'s deposit fell from {} to {now}", dep[x]);
                dep[x] = now;
            }
            if what != "mint_for" {
                assert_eq!(w.env.lamports(&keeper.pubkey()), keeper_before, "step {step}: the keeper's lamports moved outside its own mint");
            }
        }
    }
    if deposits {
        println!("walk {seed:#x} with deposits: {deposited} deposits, {minted_for} mints by the keeper");
        assert!(deposited > 0 && minted_for > 0, "the walk exercised deposits and mints for others");
    }
    let c = w.cfg();
    println!(
        "walk {seed:#x}: {steps} steps, (ok, failed) per kind {:?}; live {} waiting {} ever minted {} queued {}; {travelled} pieces travelled, {burned_in_transfers} burned in transfers",
        counts,
        c.live,
        c.reserved_pending,
        c.minted,
        w.queue().len()
    );
    assert!(travelled > 0 && burned_in_transfers > 0, "the walk exercised both a move and a burn");
}

#[test]
fn a_random_walk_keeps_every_invariant_with_a_small_supply() {
    random_walk(0x9E3779B97F4A7C15, 1200, 12, false);
}

#[test]
fn a_random_walk_keeps_every_invariant_with_a_large_supply() {
    random_walk(0xD1B54A32D192ED03, 1200, 10_000, false);
    random_walk(0x2545F4914F6CDD1D, 1200, 10_000, false);
}

#[test]
fn a_random_walk_with_deposits_keeps_every_deposit_with_its_wallet() {
    // Round 8: deposits, withdraws and mints for others among every other instruction.
    random_walk(0xA0761D6478BD642F, 1200, 10_000, true);
    random_walk(0xE7037ED1A0B428DB, 1200, 12, true);
}

#[test]
fn a_transfer_keeps_both_wallets_deposits() {
    // Round 8: what a ticket holds above its rent is its wallet's deposit. The transfer hook
    // used to pay the receiver's growth out of the receiver's own surplus first, which
    // handed part of the receiver's deposit to the sender. Now the sender's freed rent pays
    // the growth in full, and neither deposit moves; the same for the burn queue.
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let b = w.wallet(true);
    let c = w.wallet(false);
    w.buy_and_mint(&a, 100, SOL); // three pieces on four units
    w.env.ok(&[system_instruction::transfer(&a.pubkey(), &ticket_of(&w.k.pool, &a.pubkey()), 700_001)], &[&a]);
    w.env.ok(&[system_instruction::transfer(&b.pubkey(), &ticket_of(&w.k.pool, &b.pubkey()), 300_003)], &[&b]);

    // three units to b: two pieces lose their backing at a and move to b, whose ticket grows
    w.transfer(&a, &b.pubkey(), 3 * UNIT);
    assert_eq!(w.ticket(&b.pubkey()).owned.len(), 2);
    assert_eq!((deposit_of(&w, &a.pubkey()), deposit_of(&w, &b.pubkey())), (700_001, 300_003));
    // a sells everything: its last piece burns into the queue inside the swap
    w.sell_down_to(&a, 0);
    assert_eq!(w.queue().len(), 1);
    assert_eq!(deposit_of(&w, &a.pubkey()), 700_001);
    // b sends its coins to a wallet without a ticket: both pieces burn
    let all = w.coins(&b.pubkey());
    w.transfer(&b, &c.pubkey(), all);
    assert_eq!(w.queue().len(), 3);
    assert_eq!(deposit_of(&w, &b.pubkey()), 300_003);
    // a stranger reaps the queue: the reaper gets the assets' rent, the deposits stay
    let stranger = w.env.user(SOL);
    let q = w.queue();
    w.env.ok(&[compute_budget_ix(400_000), reap_ix(&stranger.pubkey(), &w.k, &q)], &[&stranger]);
    assert_eq!((deposit_of(&w, &a.pubkey()), deposit_of(&w, &b.pubkey())), (700_001, 300_003));
    // and each wallet takes its own back
    w.env.ok(&[withdraw_ix(&a.pubkey(), &w.k)], &[&a]);
    w.env.ok(&[withdraw_ix(&b.pubkey(), &w.k)], &[&b]);
    assert_eq!((deposit_of(&w, &a.pubkey()), deposit_of(&w, &b.pubkey())), (0, 0));
}

#[test]
fn a_keeper_mints_a_pegged_coins_pieces_into_the_buyer() {
    let mut w = world(1_000, 3);
    let a = w.wallet(true);
    let keeper = w.env.user(SOL);
    go(&mut w.env, 100);
    let hook = hook_for(&w.k, &a.pubkey());
    let swap = w.env.swap_ix(&a.pubkey(), &w.k, &hook, DIRECTION_BUY, SOL, 0);
    w.env.ok(&[compute_budget_ix(400_000), swap, system_instruction::transfer(&a.pubkey(), &ticket_of(&w.k.pool, &a.pubkey()), SOL / 50)], &[&a]);
    go(&mut w.env, 103);
    w.env.ok(&[compute_budget_ix(400_000), mint_for_ix(&keeper.pubkey(), &w.k, &a.pubkey(), 0, 3)], &[&keeper]);
    let t = w.ticket(&a.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (3, 0));
    for p in w.assets(&a.pubkey(), 3) {
        assert_eq!(w.core_owner(&p), a.pubkey());
    }
    // the pieces travel with the coins as any other: a plain transfer of a unit carries one
    let b = w.wallet(true);
    w.transfer(&a, &b.pubkey(), w.coins(&a.pubkey()) - 2 * UNIT);
    assert_eq!(w.ticket(&b.pubkey()).owned.len(), 1);
}

#[test]
fn a_buy_paid_out_to_another_wallet_earns_nothing_it_cannot_back() {
    // A swap may pay out to a token account of another wallet. The buyer still earns the
    // pieces of its buy, as waiting pieces, and keeps only what its own coins back.
    let mut w = world(1_000, 3);
    let a = w.wallet(true); // signs and pays
    let b = w.wallet(true); // receives the coins
    go(&mut w.env, 100);
    let hook = hook_for(&w.k, &a.pubkey());
    let mut ix = w.env.swap_ix(&a.pubkey(), &w.k, &hook, DIRECTION_BUY, SOL, 0);
    for m in ix.accounts.iter_mut() {
        if m.pubkey == coins_of(&w.k, &a.pubkey()) {
            m.pubkey = coins_of(&w.k, &b.pubkey());
        }
    }
    // the coin's own hook looks up the receiver's ticket in every transfer: without its address the swap fails
    w.env.err(&[compute_budget_ix(400_000), ix.clone()], &[&a], "extra accounts");
    ix.accounts.push(AccountMeta::new(ticket_of(&w.k.pool, &b.pubkey()), false));
    w.env.ok(&[compute_budget_ix(400_000), ix], &[&a]);
    assert!(w.coins(&b.pubkey()) > 4 * UNIT);
    assert_eq!(w.coins(&a.pubkey()), 0);
    assert_eq!(w.ticket(&a.pubkey()).pending(), 3, "the buy earned its pieces to the wallet that signed it");
    assert_eq!(w.ticket(&b.pubkey()).pending(), 0);

    // a holds no coins: anyone's settle drops what nothing backs, and nothing is ever minted
    go(&mut w.env, 103);
    let keeper = w.env.user(SOL);
    w.env.ok(&[compute_budget_ix(400_000), settle_ix(&keeper.pubkey(), &w.k, &a.pubkey(), &[])], &[&keeper]);
    let t = w.ticket(&a.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (0, 0));
    assert_eq!((w.cfg().live, w.cfg().reserved_pending), (0, 0));
    assert_eq!(w.ticket(&b.pubkey()).owned.len(), 0);
}

// ---- final review, 2026-10-12 ---------------------------------------------------------------

#[test]
fn dust_that_completes_a_unit_carries_no_piece() {
    // Final review: the receiver took one piece per whole unit its balance GAINED. A wallet
    // sitting ten coins under a unit could be handed a stranger's piece for ten coins, and
    // its next sale then dropped one of its own waiting pieces instead. Now a piece travels
    // per whole unit SENT.
    let mut w = world(1_000, 3);
    let x = w.wallet(true);
    let v = w.wallet(true);
    w.buy_and_mint(&x, 100, SOL);
    let px = w.assets(&x.pubkey(), 3);
    w.sell_down_to(&x, 3 * UNIT); // three pieces on exactly three units
    go(&mut w.env, 110);
    w.buy(&v, 13 * SOL / 10);
    w.sell_down_to(&v, 4 * UNIT - 10); // ten coins under four units, three waiting pieces
    assert_eq!((w.ticket(&v.pubkey()).owned.len(), w.ticket(&v.pubkey()).pending()), (0, 3));

    w.transfer(&x, &v.pubkey(), 10);
    assert_eq!(w.coins(&v.pubkey()), 4 * UNIT, "the dust completed v's fourth unit");
    assert_eq!(w.ticket(&x.pubkey()).owned, vec![px[0], px[1]], "x's unbacked piece left x");
    assert_eq!(w.queue(), vec![px[2]], "and burned");
    let t = w.ticket(&v.pubkey());
    assert_eq!((t.owned.len(), t.pending()), (0, 3), "nothing was pushed into v's list");

    // v's own sale keeps v's own waiting pieces
    w.sell_down_to(&v, 3 * UNIT + UNIT / 2);
    assert_eq!(w.ticket(&v.pubkey()).pending(), 3);

    // a unit and a half carries one piece: one whole unit was sent
    w.transfer(&x, &v.pubkey(), UNIT + UNIT / 2);
    assert_eq!(w.ticket(&v.pubkey()).owned, vec![px[1]]);
    assert_eq!(w.ticket(&x.pubkey()).owned, vec![px[0]]);
    assert_eq!(w.queue(), vec![px[2]], "nothing more burned: x still holds a unit and a half for one piece");
}

#[test]
fn a_stage_does_not_survive_a_change_of_the_list() {
    // Final review: a stage is a count. A piece that arrived, a mint or a reorder between
    // the stage and the transfer made it point at other pieces.
    let mut w = world(1_000, 3);
    let v = w.wallet(true);
    let x = w.wallet(true);
    let buyer = w.wallet(true);
    w.buy_and_mint(&v, 100, SOL);
    w.buy_and_mint(&x, 110, SOL);
    let pv = w.assets(&v.pubkey(), 3);
    let px = w.assets(&x.pubkey(), 3);

    // v stages its last piece, alone. In the same slot x sends v a piece with its unit.
    w.env.ok(&[stage_ix(&v.pubkey(), &w.k, &[pv[2]])], &[&v]);
    assert_eq!(w.ticket(&v.pubkey()).staged, 1);
    w.env.ok(&[stage_ix(&x.pubkey(), &w.k, &[px[2]]), transfer_ix(&w.k, &x.pubkey(), &v.pubkey(), UNIT)], &[&x]);
    assert_eq!(w.ticket(&v.pubkey()).owned, vec![pv[0], pv[1], pv[2], px[2]]);
    assert_eq!(w.ticket(&v.pubkey()).staged, 0, "the arrival cleared v's stage");
    // v's transfer, still in that slot, carries nothing: its coins back all four
    w.transfer(&v, &buyer.pubkey(), UNIT);
    assert_eq!(w.ticket(&buyer.pubkey()).owned.len(), 0);
    assert_eq!(w.ticket(&v.pubkey()).owned, vec![pv[0], pv[1], pv[2], px[2]]);

    // a reorder clears a stage too
    w.env.ok(&[stage_ix(&v.pubkey(), &w.k, &[px[2]])], &[&v]);
    w.env.ok(&[reorder_ix(&v.pubkey(), &w.k, 0, 3)], &[&v]);
    assert_eq!(w.ticket(&v.pubkey()).staged, 0);
    // and so does a mint
    go(&mut w.env, 120);
    w.buy(&v, SOL / 2);
    let last = *w.ticket(&v.pubkey()).owned.last().unwrap();
    go(&mut w.env, 123);
    let t = w.ticket(&v.pubkey());
    let n = t.pending();
    assert!(n >= 1);
    w.env.ok(&[stage_ix(&v.pubkey(), &w.k, &[last]), compute_budget_ix(600_000), mint_ix(&v.pubkey(), &w.k, n as u8, t.minted, n)], &[&v]);
    assert_eq!(w.ticket(&v.pubkey()).staged, 0);
}

#[test]
fn opening_a_ticket_that_is_open_changes_nothing() {
    // Final review: a stranger could open a wallet's ticket first, and the wallet's own
    // "open my ticket, then buy" transaction failed once.
    let mut w = world(1_000, 3);
    let stranger = w.env.user(SOL);
    let a = w.wallet(false);
    w.env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &w.k.pool, &a.pubkey())], &[&stranger]);
    // a's own first buy, built before it knew
    go(&mut w.env, 100);
    let hook = hook_for(&w.k, &a.pubkey());
    let buy = w.env.swap_ix(&a.pubkey(), &w.k, &hook, DIRECTION_BUY, SOL, 0);
    w.env.ok(&[compute_budget_ix(400_000), open_ticket_ix(&a.pubkey(), &w.k.pool), buy], &[&a]);
    assert_eq!(w.ticket(&a.pubkey()).pending(), 3, "the buy went through and earned");
    go(&mut w.env, 103);
    w.env.ok(&[compute_budget_ix(400_000), mint_ix(&a.pubkey(), &w.k, 3, 0, 3)], &[&a]);

    // opening again, by anyone, leaves a ticket with pieces exactly as it is
    let before = w.env.svm.get_account(&ticket_of(&w.k.pool, &a.pubkey())).unwrap();
    w.env.ok(&[open_ticket_ix(&a.pubkey(), &w.k.pool)], &[&a]);
    w.env.ok(&[open_ticket_for_ix(&stranger.pubkey(), &w.k.pool, &a.pubkey())], &[&stranger]);
    let after = w.env.svm.get_account(&ticket_of(&w.k.pool, &a.pubkey())).unwrap();
    assert_eq!((after.data, after.lamports), (before.data, before.lamports));
    assert_eq!(w.ticket(&a.pubkey()).owned.len(), 3);

    // lamports sent to a ticket's address beforehand do not block it
    let b = w.wallet(false);
    let address = ticket_of(&w.k.pool, &b.pubkey());
    w.env.ok(&[system_instruction::transfer(&stranger.pubkey(), &address, 1_000_000)], &[&stranger]);
    w.env.ok(&[open_ticket_ix(&b.pubkey(), &w.k.pool)], &[&b]);
    let t = w.ticket(&b.pubkey());
    assert_eq!((t.user, t.pool, t.owned.len()), (b.pubkey(), w.k.pool, 0));
    // nobody opens a ticket at another address, or for another program's account
    let mut wrong = open_ticket_ix(&b.pubkey(), &w.k.pool);
    wrong.accounts[1].pubkey = ticket_of(&w.k.pool, &a.pubkey());
    assert!(w.env.send(&[wrong], &[&b]).is_err());
}
