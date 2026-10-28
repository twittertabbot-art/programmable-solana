//! Test harness: a LiteSVM with every program loaded, the platform initialised,
//! the template hooks registered, and helpers that build instructions the same
//! way the SDK will.

pub use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use hookpool_interface::*;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::path::PathBuf;

pub const TOKEN: Pubkey = anchor_spl::token::ID;
pub const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
pub const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
pub const MPL: Pubkey = anchor_spl::metadata::ID;
pub const MPL_CORE: Pubkey = hook_collectible::MPL_CORE_ID;
pub const SOL: u64 = 1_000_000_000;

pub const PROTOCOL_FEE_BPS: u16 = 20;
pub const MAX_LP_FEE_BPS: u16 = 1_000;
pub const MAX_HOOK_FEE_BPS: u16 = 1_000;
pub const MAX_FEE_OVERRIDE_BPS: u16 = 5_000;
pub const LAUNCH_FEE: u64 = 10_000_000; // 0.01 SOL

pub fn deploy_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy")
}
pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name)
}
pub fn so(name: &str) -> Vec<u8> {
    let p = deploy_dir().join(format!("{name}.so"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}. Run build.sh first.", p.display()))
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    ata_with(owner, mint, &TOKEN)
}
/// The associated token account under a given token program (Token-2022 coins use their own).
pub fn ata_with(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// What a pool needs to know about its hook, from the client's point of view.
#[derive(Clone, Debug)]
pub struct HookRef {
    pub program: Pubkey,
    /// Quote token account receiving hook fees; system program when the hook takes none.
    pub treasury: Pubkey,
    /// The hook's extra accounts, resolved, in order.
    pub extra: Vec<AccountMeta>,
}

impl HookRef {
    pub fn none() -> Self {
        Self { program: system_program::ID, treasury: system_program::ID, extra: vec![] }
    }
    pub fn program_data(&self) -> Pubkey {
        if self.program == system_program::ID {
            system_program::ID
        } else {
            program_data_address(&self.program)
        }
    }
    pub fn manifest(&self) -> Pubkey {
        if self.program == system_program::ID { system_program::ID } else { manifest_address(&self.program).0 }
    }
    pub fn extra_metas(&self) -> Pubkey {
        if self.program == system_program::ID { system_program::ID } else { extra_metas_address(&self.program).0 }
    }
    /// The address the pool program signs this hook's callbacks with: ["caller", hook
    /// program]. Every hook has its own; a pool without a hook passes the one of the
    /// system program, which signs nothing.
    pub fn caller(&self) -> Pubkey {
        caller_address(&self.program).0
    }
    pub fn cfg(program: &Pubkey, pool: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"cfg", pool.as_ref()], program).0
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub treasury: Keypair,
    pub platform: Pubkey,
}

impl Env {
    /// Programs loaded, nothing initialised.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(hookpool::ID, &so("hookpool")).unwrap();
        svm.add_program(hooklaunch::ID, &so("hooklaunch")).unwrap();
        svm.add_program(hook_tax::ID, &so("hook_tax")).unwrap();
        svm.add_program(hook_launch_guard::ID, &so("hook_launch_guard")).unwrap();
        svm.add_program(hook_buyback::ID, &so("hook_buyback")).unwrap();
        svm.add_program(hook_evil::ID, &so("hook_evil")).unwrap();
        svm.add_program(hook_collectible::ID, &so("hook_collectible")).unwrap();
        svm.add_program(hook_rules::ID, &so("hook_rules")).unwrap();
        svm.add_program(MPL_CORE, &std::fs::read(fixture("mpl_core.so")).unwrap()).unwrap();
        svm.add_program(MPL, &std::fs::read(fixture("mpl_token_metadata.so")).unwrap()).unwrap();
        let admin = Keypair::new();
        let treasury = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100 * SOL).unwrap();
        svm.airdrop(&treasury.pubkey(), SOL).unwrap();
        let mut env = Env {
            svm,
            admin,
            treasury,
            platform: platform_address().0,
        };
        // LiteSVM loads programs frozen. Our own programs are upgradeable by the admin.
        let admin_pk = env.admin.pubkey();
        for p in [hookpool::ID, hooklaunch::ID, hook_tax::ID, hook_launch_guard::ID, hook_buyback::ID, hook_collectible::ID, hook_rules::ID] {
            env.patch_upgrade_authority(&p, Some(admin_pk));
        }
        env
    }

    /// Platform initialised, templates registered and whitelisted.
    pub fn new() -> Self {
        let mut env = Self::bare();
        env.init_platform();
        env.set_whitelist(vec![env.admin.pubkey()]);
        env.init_manifests();
        env
    }

    // ---- transactions -----------------------------------------------------------

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = signers[0].pubkey();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => m,
            Err(e) => panic!("transaction failed: {:?}\n{}", e.err, e.meta.pretty_logs()),
        }
    }

    /// Asserts failure and that the logs mention `needle`.
    pub fn err(&mut self, ixs: &[Instruction], signers: &[&Keypair], needle: &str) -> FailedTransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => panic!("expected failure containing {needle:?}, but it succeeded\n{}", m.pretty_logs()),
            Err(e) => {
                let hay = format!("{:?}\n{}", e.err, e.meta.logs.join("\n"));
                assert!(hay.contains(needle), "expected {needle:?} in:\n{hay}");
                e
            }
        }
    }

    pub fn tx_size(&self, ixs: &[Instruction], payer: &Pubkey, n_signers: usize) -> usize {
        let msg = Message::new_with_blockhash(ixs, Some(payer), &self.svm.latest_blockhash());
        let vm = VersionedMessage::Legacy(msg);
        bincode_len(&vm) + 1 + 64 * n_signers
    }

    pub fn simulate_return(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Vec<u8> {
        let payer = signers[0].pubkey();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        match self.svm.simulate_transaction(tx) {
            Ok(info) => info.meta.return_data.data,
            Err(e) => panic!("simulation failed: {:?}\n{}", e.err, e.meta.pretty_logs()),
        }
    }

    // ---- accounts -----------------------------------------------------------------

    pub fn user(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol).unwrap();
        k
    }

    pub fn account<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.svm.get_account(key).unwrap_or_else(|| panic!("no account {key}"));
        let mut data: &[u8] = &acc.data;
        T::try_deserialize(&mut data).unwrap()
    }

    pub fn pool(&self, key: &Pubkey) -> hookpool::Pool {
        self.account(key)
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        match self.svm.get_account(token_account) {
            Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let a = self.svm.get_account(mint).unwrap();
        u64::from_le_bytes(a.data[36..44].try_into().unwrap())
    }

    /// Mint authority of a classic SPL mint, None when revoked.
    pub fn mint_authority(&self, mint: &Pubkey) -> Option<Pubkey> {
        let a = self.svm.get_account(mint).unwrap();
        if u32::from_le_bytes(a.data[0..4].try_into().unwrap()) == 0 {
            None
        } else {
            Some(Pubkey::new_from_array(a.data[4..36].try_into().unwrap()))
        }
    }

    pub fn patch_upgrade_authority(&mut self, program_id: &Pubkey, authority: Option<Pubkey>) {
        let pd = program_data_address(program_id);
        let mut acc = self.svm.get_account(&pd).expect("program data");
        match authority {
            None => {
                acc.data[12] = 0;
                acc.data[13..45].fill(0);
            }
            Some(a) => {
                acc.data[12] = 1;
                acc.data[13..45].copy_from_slice(a.as_ref());
            }
        }
        self.svm
            .set_account(
                pd,
                Account {
                    lamports: acc.lamports,
                    data: acc.data,
                    owner: acc.owner,
                    executable: acc.executable,
                    rent_epoch: acc.rent_epoch,
                },
            )
            .unwrap();
    }

    // ---- tokens ------------------------------------------------------------------

    pub fn create_mint(&mut self, authority: &Keypair, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let lamports = self.svm.minimum_balance_for_rent_exemption(82);
        let ixs = [
            system_instruction::create_account(&authority.pubkey(), &mint.pubkey(), lamports, 82, &TOKEN),
            anchor_spl::token::spl_token::instruction::initialize_mint2(
                &TOKEN,
                &mint.pubkey(),
                &authority.pubkey(),
                None,
                decimals,
            )
            .unwrap(),
        ];
        self.ok(&ixs, &[authority, &mint]);
        mint.pubkey()
    }

    pub fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
        Self::create_ata_with_ix(payer, owner, mint, &TOKEN)
    }

    pub fn create_ata_with_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
        Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new(ata_with(owner, mint, token_program), false),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(*token_program, false),
            ],
            data: vec![1], // CreateIdempotent
        }
    }

    /// A plain (non-associated) token account, for tests that need one.
    pub fn create_token_account(&mut self, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        let acc = Keypair::new();
        let lamports = self.svm.minimum_balance_for_rent_exemption(165);
        let ixs = [
            system_instruction::create_account(&payer.pubkey(), &acc.pubkey(), lamports, 165, &TOKEN),
            anchor_spl::token::spl_token::instruction::initialize_account3(&TOKEN, &acc.pubkey(), mint, owner).unwrap(),
        ];
        self.ok(&ixs, &[payer, &acc]);
        acc.pubkey()
    }

    /// SPL CloseAccount for a zero-balance token account.
    pub fn close_token_account(&mut self, owner: &Keypair, account: &Pubkey) {
        let ix = anchor_spl::token::spl_token::instruction::close_account(&TOKEN, account, &owner.pubkey(), &owner.pubkey(), &[]).unwrap();
        self.ok(&[ix], &[owner]);
    }

    pub fn create_ata(&mut self, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        self.ok(&[Self::create_ata_ix(&payer.pubkey(), owner, mint)], &[payer]);
        ata(owner, mint)
    }

    pub fn mint_to(&mut self, authority: &Keypair, mint: &Pubkey, to: &Pubkey, amount: u64) {
        let ix = anchor_spl::token::spl_token::instruction::mint_to(
            &TOKEN,
            mint,
            to,
            &authority.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        self.ok(&[ix], &[authority]);
    }

    /// Creates the two ATAs for `user` and funds them from `mint_authority`.
    pub fn fund(
        &mut self,
        user: &Keypair,
        mint_authority: &Keypair,
        base_mint: &Pubkey,
        quote_mint: &Pubkey,
        base_amount: u64,
        quote_amount: u64,
    ) -> (Pubkey, Pubkey) {
        let ub = self.create_ata(user, &user.pubkey(), base_mint);
        let uq = self.create_ata(user, &user.pubkey(), quote_mint);
        if base_amount > 0 {
            self.mint_to(mint_authority, base_mint, &ub, base_amount);
        }
        if quote_amount > 0 {
            self.mint_to(mint_authority, quote_mint, &uq, quote_amount);
        }
        (ub, uq)
    }

    // ---- platform -----------------------------------------------------------------

    pub fn init_platform_ix(&self, admin: &Pubkey) -> Instruction {
        Instruction {
            program_id: hookpool::ID,
            accounts: hookpool::accounts::InitPlatform {
                admin: *admin,
                platform: self.platform,
                program_data: program_data_address(&hookpool::ID),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hookpool::instruction::InitPlatform {
                args: hookpool::InitPlatformArgs {
                    treasury: self.treasury.pubkey(),
                    protocol_fee_bps: PROTOCOL_FEE_BPS,
                    max_lp_fee_bps: MAX_LP_FEE_BPS,
                    max_hook_fee_bps: MAX_HOOK_FEE_BPS,
                    max_fee_override_bps: MAX_FEE_OVERRIDE_BPS,
                    launch_fee_lamports: LAUNCH_FEE,
                },
            }
            .data(),
        }
    }

    pub fn init_platform(&mut self) {
        let ix = self.init_platform_ix(&self.admin.pubkey());
        let admin = self.admin.insecure_clone();
        self.ok(&[ix], &[&admin]);
    }

    pub fn admin_ix(&self, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: hookpool::ID,
            accounts: hookpool::accounts::AdminOnly { admin: self.admin.pubkey(), platform: self.platform }
                .to_account_metas(None),
            data,
        }
    }

    pub fn set_whitelist(&mut self, keys: Vec<Pubkey>) {
        let ix = self.admin_ix(hookpool::instruction::SetWhitelist { keys }.data());
        let admin = self.admin.insecure_clone();
        self.ok(&[ix], &[&admin]);
    }

    pub fn update_platform(&mut self, args: hookpool::UpdatePlatformArgs) {
        let ix = self.admin_ix(hookpool::instruction::UpdatePlatform { args }.data());
        let admin = self.admin.insecure_clone();
        self.ok(&[ix], &[&admin]);
    }

    pub fn init_manifests(&mut self) {
        let admin = self.admin.insecure_clone();
        let a = admin.pubkey();
        let tax = Instruction {
            program_id: hook_tax::ID,
            accounts: hook_tax::accounts::InitManifest {
                authority: a,
                program_data: program_data_address(&hook_tax::ID),
                manifest: manifest_address(&hook_tax::ID).0,
                extra_metas: extra_metas_address(&hook_tax::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_tax::instruction::InitManifest { uri: "https://example.invalid/tax".into() }.data(),
        };
        let guard = Instruction {
            program_id: hook_launch_guard::ID,
            accounts: hook_launch_guard::accounts::InitManifest {
                authority: a,
                program_data: program_data_address(&hook_launch_guard::ID),
                manifest: manifest_address(&hook_launch_guard::ID).0,
                extra_metas: extra_metas_address(&hook_launch_guard::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_launch_guard::instruction::InitManifest { uri: "https://example.invalid/guard".into() }
                .data(),
        };
        let buyback = Instruction {
            program_id: hook_buyback::ID,
            accounts: hook_buyback::accounts::InitManifest {
                authority: a,
                program_data: program_data_address(&hook_buyback::ID),
                manifest: manifest_address(&hook_buyback::ID).0,
                extra_metas: extra_metas_address(&hook_buyback::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_buyback::instruction::InitManifest { uri: "https://example.invalid/buyback".into() }
                .data(),
        };
        self.ok(&[tax, guard, buyback], &[&admin]);
        let collectible = Instruction {
            program_id: hook_collectible::ID,
            accounts: hook_collectible::accounts::InitManifest {
                authority: a,
                program_data: program_data_address(&hook_collectible::ID),
                manifest: manifest_address(&hook_collectible::ID).0,
                extra_metas: extra_metas_address(&hook_collectible::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_collectible::instruction::InitManifest { uri: "https://example.invalid/collectible".into() }
                .data(),
        };
        let rules = Instruction {
            program_id: hook_rules::ID,
            accounts: hook_rules::accounts::InitManifest {
                authority: a,
                program_data: program_data_address(&hook_rules::ID),
                manifest: manifest_address(&hook_rules::ID).0,
                extra_metas: extra_metas_address(&hook_rules::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_rules::instruction::InitManifest { uri: "https://example.invalid/rules".into() }.data(),
        };
        self.ok(&[collectible, rules], &[&admin]);
    }

    pub fn init_evil_manifest(&mut self, flags: u32) {
        let admin = self.admin.insecure_clone();
        let ix = Instruction {
            program_id: hook_evil::ID,
            accounts: hook_evil::accounts::InitManifest {
                authority: admin.pubkey(),
                manifest: manifest_address(&hook_evil::ID).0,
                extra_metas: extra_metas_address(&hook_evil::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_evil::instruction::InitManifest { flags }.data(),
        };
        self.ok(&[ix], &[&admin]);
    }

    // ---- pools -----------------------------------------------------------------------

    pub fn pool_keys(base_mint: &Pubkey, quote_mint: &Pubkey) -> PoolKeys {
        Self::pool_keys_with(base_mint, quote_mint, &TOKEN)
    }

    /// Pool keys for a coin under a given token program.
    pub fn pool_keys_with(base_mint: &Pubkey, quote_mint: &Pubkey, base_program: &Pubkey) -> PoolKeys {
        let pool = pool_address(base_mint, quote_mint).0;
        PoolKeys {
            pool,
            base_program: *base_program,
            base_mint: *base_mint,
            quote_mint: *quote_mint,
            base_vault: vault_address(&pool, base_mint).0,
            quote_vault: vault_address(&pool, quote_mint).0,
            lp_mint: lp_mint_address(&pool).0,
            lp_lock: lp_lock_address(&pool).0,
        }
    }

    pub fn create_pool_ix(
        &self,
        creator: &Pubkey,
        k: &PoolKeys,
        lp_fee_bps: u16,
        base_amount: u64,
        quote_amount: u64,
        hook: &HookRef,
    ) -> Instruction {
        let mut accounts = hookpool::accounts::CreatePool {
            payer: *creator,
            authority: *creator,
            platform: self.platform,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            pool: k.pool,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            lp_mint: k.lp_mint,
            lp_lock: k.lp_lock,
            authority_base: ata_with(creator, &k.base_mint, &k.base_program),
            authority_quote: ata(creator, &k.quote_mint),
            authority_lp: ata(creator, &k.lp_mint),
            hook_program: hook.program,
            hook_program_data: hook.program_data(),
            hook_manifest: hook.manifest(),
            hook_extra_metas: hook.extra_metas(),
            hook_quote_treasury: hook.treasury,
            hook_caller: hook.caller(),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
            token_program: TOKEN,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
            event_authority: event_authority_address(&hookpool::ID),
            program: hookpool::ID,
        }
        .to_account_metas(None);
        accounts.extend(hook.extra.iter().cloned());
        Instruction {
            program_id: hookpool::ID,
            accounts,
            data: hookpool::instruction::CreatePool {
                args: hookpool::CreatePoolArgs { lp_fee_bps, base_amount, quote_amount },
            }
            .data(),
        }
    }

    pub fn create_pool(
        &mut self,
        creator: &Keypair,
        base_mint: &Pubkey,
        quote_mint: &Pubkey,
        lp_fee_bps: u16,
        base_amount: u64,
        quote_amount: u64,
        hook: &HookRef,
    ) -> PoolKeys {
        let k = Self::pool_keys(base_mint, quote_mint);
        let ix = self.create_pool_ix(&creator.pubkey(), &k, lp_fee_bps, base_amount, quote_amount, hook);
        // A pool creation derives eight addresses and may call a hook. How many units that
        // takes depends on the addresses; with a hook it can pass the default 200,000.
        self.ok(&[compute_budget_ix(400_000), ix], &[creator]);
        k
    }

    /// `create_curve_pool`: the accounts of `create_pool`, no quote amount.
    pub fn create_curve_pool_ix(&self, creator: &Pubkey, k: &PoolKeys, lp_fee_bps: u16, base_amount: u64, hook: &HookRef) -> Instruction {
        let mut ix = self.create_pool_ix(creator, k, lp_fee_bps, base_amount, 0, hook);
        ix.data = hookpool::instruction::CreateCurvePool { args: hookpool::CreateCurvePoolArgs { lp_fee_bps, base_amount } }.data();
        ix
    }

    pub fn create_curve_pool(&mut self, creator: &Keypair, k: &PoolKeys, lp_fee_bps: u16, base_amount: u64, hook: &HookRef) -> TransactionMetadata {
        let ix = self.create_curve_pool_ix(&creator.pubkey(), k, lp_fee_bps, base_amount, hook);
        self.ok(&[compute_budget_ix(400_000), ix], &[creator])
    }

    /// `graduate`: permissionless, no signer among its accounts; whoever pays the fee sends it.
    pub fn graduate_ix(&self, k: &PoolKeys) -> Instruction {
        Instruction {
            program_id: hookpool::ID,
            accounts: hookpool::accounts::Graduate {
                platform: self.platform,
                pool: k.pool,
                base_mint: k.base_mint,
                base_vault: k.base_vault,
                base_token_program: k.base_program,
                event_authority: event_authority_address(&hookpool::ID),
                program: hookpool::ID,
            }
            .to_account_metas(None),
            data: hookpool::instruction::Graduate {}.data(),
        }
    }

    /// A coin fit for the curve: the whole supply in `owner`'s associated account and no
    /// mint authority left, under either token program (a Token-2022 coin carries the one
    /// extension the pool takes, where its name lives).
    pub fn closed_coin(&mut self, owner: &Keypair, token_program: &Pubkey, supply: u64) -> Pubkey {
        use anchor_spl::token_2022::spl_token_2022 as t22;
        let mint = Keypair::new();
        let mut ixs = if *token_program == TOKEN {
            vec![
                system_instruction::create_account(&owner.pubkey(), &mint.pubkey(), self.svm.minimum_balance_for_rent_exemption(82), 82, &TOKEN),
                t22::instruction::initialize_mint2(&TOKEN, &mint.pubkey(), &owner.pubkey(), None, 6).unwrap(),
            ]
        } else {
            use t22::extension::ExtensionType;
            let space = ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[ExtensionType::MetadataPointer]).unwrap();
            vec![
                system_instruction::create_account(&owner.pubkey(), &mint.pubkey(), self.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
                t22::extension::metadata_pointer::instruction::initialize(&TOKEN_2022, &mint.pubkey(), None, Some(mint.pubkey())).unwrap(),
                t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &owner.pubkey(), None, 6).unwrap(),
            ]
        };
        let acc = ata_with(&owner.pubkey(), &mint.pubkey(), token_program);
        ixs.push(Self::create_ata_with_ix(&owner.pubkey(), &owner.pubkey(), &mint.pubkey(), token_program));
        ixs.push(t22::instruction::mint_to(token_program, &mint.pubkey(), &acc, &owner.pubkey(), &[], supply).unwrap());
        ixs.push(t22::instruction::set_authority(token_program, &mint.pubkey(), None, t22::instruction::AuthorityType::MintTokens, &owner.pubkey(), &[]).unwrap());
        self.ok(&ixs, &[owner, &mint]);
        mint.pubkey()
    }

    pub fn swap_ix(
        &self,
        user: &Pubkey,
        k: &PoolKeys,
        hook: &HookRef,
        direction: u8,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Instruction {
        let mut accounts = hookpool::accounts::Swap {
            user: *user,
            platform: self.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            user_base: ata_with(user, &k.base_mint, &k.base_program),
            user_quote: ata(user, &k.quote_mint),
            hook_quote_treasury: if hook.treasury == system_program::ID { ata(user, &k.quote_mint) } else { hook.treasury },
            hook_program: hook.program,
            hook_extra_metas: hook.extra_metas(),
            hook_caller: hook.caller(),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hookpool::ID),
            program: hookpool::ID,
        }
        .to_account_metas(None);
        accounts.extend(hook.extra.iter().cloned());
        Instruction {
            program_id: hookpool::ID,
            accounts,
            data: hookpool::instruction::Swap { direction, amount_in, min_amount_out }.data(),
        }
    }

    pub fn swap(
        &mut self,
        user: &Keypair,
        k: &PoolKeys,
        hook: &HookRef,
        direction: u8,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.swap_ix(&user.pubkey(), k, hook, direction, amount_in, min_amount_out);
        self.send(&[ix], &[user])
    }

    pub fn liquidity_ix(
        &self,
        user: &Pubkey,
        k: &PoolKeys,
        hook: &HookRef,
        data: Vec<u8>,
    ) -> Instruction {
        let mut accounts = hookpool::accounts::ModifyLiquidity {
            user: *user,
            platform: self.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            lp_mint: k.lp_mint,
            user_base: ata_with(user, &k.base_mint, &k.base_program),
            user_quote: ata(user, &k.quote_mint),
            user_lp: ata(user, &k.lp_mint),
            hook_program: hook.program,
            hook_extra_metas: hook.extra_metas(),
            hook_caller: hook.caller(),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
            token_program: TOKEN,
            event_authority: event_authority_address(&hookpool::ID),
            program: hookpool::ID,
        }
        .to_account_metas(None);
        accounts.extend(hook.extra.iter().cloned());
        Instruction { program_id: hookpool::ID, accounts, data }
    }

    pub fn add_liquidity_ix(&self, user: &Pubkey, k: &PoolKeys, hook: &HookRef, lp: u64, max_b: u64, max_q: u64) -> Instruction {
        self.liquidity_ix(
            user,
            k,
            hook,
            hookpool::instruction::AddLiquidity { lp_amount: lp, max_base: max_b, max_quote: max_q }.data(),
        )
    }

    pub fn remove_liquidity_ix(&self, user: &Pubkey, k: &PoolKeys, hook: &HookRef, lp: u64, min_b: u64, min_q: u64) -> Instruction {
        self.liquidity_ix(
            user,
            k,
            hook,
            hookpool::instruction::RemoveLiquidity { lp_amount: lp, min_base: min_b, min_quote: min_q }.data(),
        )
    }

    pub fn collect_ix(&self, payer: &Pubkey, k: &PoolKeys) -> Instruction {
        let t = self.treasury.pubkey();
        Instruction {
            program_id: hookpool::ID,
            accounts: hookpool::accounts::CollectProtocolFees {
                payer: *payer,
                platform: self.platform,
                pool: k.pool,
                base_mint: k.base_mint,
                quote_mint: k.quote_mint,
                base_vault: k.base_vault,
                quote_vault: k.quote_vault,
                treasury: t,
                treasury_base: ata_with(&t, &k.base_mint, &k.base_program),
                treasury_quote: ata(&t, &k.quote_mint),
                base_token_program: k.base_program,
                quote_token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hookpool::instruction::CollectProtocolFees {}.data(),
        }
    }

    // ---- template hook setup ------------------------------------------------------

    /// Tax hook config for a future pool. Treasury = `treasury_owner`'s quote ATA (must exist).
    pub fn tax_hook(&mut self, payer: &Keypair, owner: &Keypair, pool: &Pubkey, quote_mint: &Pubkey, treasury_owner: &Pubkey, buy: u16, sell: u16, max: u16) -> HookRef {
        let cfg = HookRef::cfg(&hook_tax::ID, pool);
        let ix = Instruction {
            program_id: hook_tax::ID,
            accounts: hook_tax::accounts::InitPoolConfig {
                payer: payer.pubkey(),
                owner: owner.pubkey(),
                cfg,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_tax::instruction::InitPoolConfig { pool: *pool, buy_bps: buy, sell_bps: sell, max_bps: max }.data(),
        };
        if payer.pubkey() == owner.pubkey() {
            self.ok(&[ix], &[payer]);
        } else {
            self.ok(&[ix], &[payer, owner]);
        }
        HookRef { program: hook_tax::ID, treasury: ata(treasury_owner, quote_mint), extra: vec![AccountMeta::new_readonly(cfg, false)] }
    }

    pub fn guard_hook(&mut self, payer: &Keypair, pool: &Pubkey, guard_slots: u64, start_fee_bps: u16) -> HookRef {
        let cfg = HookRef::cfg(&hook_launch_guard::ID, pool);
        let ix = Instruction {
            program_id: hook_launch_guard::ID,
            accounts: hook_launch_guard::accounts::InitPoolConfig { payer: payer.pubkey(), cfg, system_program: system_program::ID }
                .to_account_metas(None),
            data: hook_launch_guard::instruction::InitPoolConfig { pool: *pool, guard_slots, start_fee_bps }.data(),
        };
        self.ok(&[ix], &[payer]);
        HookRef { program: hook_launch_guard::ID, treasury: system_program::ID, extra: vec![AccountMeta::new(cfg, false)] }
    }

    pub fn buyback_hook(&mut self, payer: &Keypair, pool: &Pubkey, base_mint: &Pubkey, quote_mint: &Pubkey, buy: u16, sell: u16, min_quote: u64) -> HookRef {
        let cfg = HookRef::cfg(&hook_buyback::ID, pool);
        let authority = hook_authority_address(pool, &hook_buyback::ID).0;
        let ix = Instruction {
            program_id: hook_buyback::ID,
            accounts: hook_buyback::accounts::InitPoolConfig {
                payer: payer.pubkey(),
                cfg,
                hook_authority: authority,
                base_mint: *base_mint,
                quote_mint: *quote_mint,
                treasury_quote: ata(&authority, quote_mint),
                authority_base: ata(&authority, base_mint),
                base_token_program: TOKEN,
                quote_token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_buyback::instruction::InitPoolConfig { pool: *pool, buy_bps: buy, sell_bps: sell, min_quote }.data(),
        };
        self.ok(&[ix], &[payer]);
        // the config is writable: `before_swap` lowers the buyback's observation in it
        HookRef { program: hook_buyback::ID, treasury: ata(&authority, quote_mint), extra: vec![AccountMeta::new(cfg, false)] }
    }

    /// `init_pool_config` of the launch rules hook for a future pool. Not sent: a launch puts
    /// it in the same transaction as the coin.
    pub fn rules_config_ix(payer: &Pubkey, k: &PoolKeys, args: hook_rules::RulesArgs) -> Instruction {
        let r = RulesKeys::of(k);
        Instruction {
            program_id: hook_rules::ID,
            accounts: hook_rules::accounts::InitPoolConfig {
                payer: *payer,
                cfg: r.cfg,
                hook_authority: r.authority,
                base_mint: k.base_mint,
                quote_mint: k.quote_mint,
                treasury_quote: r.treasury,
                authority_base: r.burn_account,
                stake_vault: r.stake_vault,
                base_token_program: k.base_program,
                quote_token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_rules::instruction::InitPoolConfig { pool: k.pool, args }.data(),
        }
    }

    /// What a client passes for a pool with the launch rules hook: the program, its
    /// treasury, and the config as the one extra account, writable.
    pub fn rules_ref(k: &PoolKeys) -> HookRef {
        let r = RulesKeys::of(k);
        HookRef { program: hook_rules::ID, treasury: r.treasury, extra: vec![AccountMeta::new(r.cfg, false)] }
    }

    /// Launch rules config for a future pool, paid by `payer` (who must then create the pool).
    pub fn rules_hook(&mut self, payer: &Keypair, k: &PoolKeys, args: hook_rules::RulesArgs) -> HookRef {
        let ix = Self::rules_config_ix(&payer.pubkey(), k, args);
        self.ok(&[compute_budget_ix(400_000), ix], &[payer]);
        Self::rules_ref(k)
    }

    /// Set the clock: the slot and the unix time programs read.
    pub fn set_clock(&mut self, slot: u64, unix_timestamp: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.slot = slot;
        c.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&c);
    }

    pub fn clock(&self) -> solana_clock::Clock {
        self.svm.get_sysvar()
    }

    pub fn evil_hook(&mut self, payer: &Keypair, pool: &Pubkey, quote_mint: &Pubkey, treasury_owner: &Pubkey, mode: u8, value: u64) -> HookRef {
        let cfg = HookRef::cfg(&hook_evil::ID, pool);
        let ix = Instruction {
            program_id: hook_evil::ID,
            accounts: hook_evil::accounts::InitPoolConfig { payer: payer.pubkey(), cfg, system_program: system_program::ID }
                .to_account_metas(None),
            data: hook_evil::instruction::InitPoolConfig { pool: *pool, mode, value }.data(),
        };
        self.ok(&[ix], &[payer]);
        HookRef { program: hook_evil::ID, treasury: ata(treasury_owner, quote_mint), extra: vec![AccountMeta::new(cfg, false)] }
    }

    /// The manifest of a RELAYING hook_evil (instead of `init_evil_manifest`). `victim`
    /// are the accounts of the callback to forge in `target`, in that callback's order
    /// but without its `hook_caller`: pool, user, quote mint, base mint, extras.
    pub fn init_evil_relay_manifest(&mut self, flags: u32, target: &Pubkey, victim: &[AccountMeta]) {
        let admin = self.admin.insecure_clone();
        let mut extras = vec![hook_evil::RelayExtra { key: *target, writable: false }];
        extras.extend(victim.iter().map(|m| hook_evil::RelayExtra { key: m.pubkey, writable: m.is_writable }));
        let ix = Instruction {
            program_id: hook_evil::ID,
            accounts: hook_evil::accounts::InitRelayManifest {
                authority: admin.pubkey(),
                manifest: manifest_address(&hook_evil::ID).0,
                extra_metas: extra_metas_address(&hook_evil::ID).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_evil::instruction::InitRelayManifest { flags, extras }.data(),
        };
        self.ok(&[ix], &[&admin]);
    }

    /// A junk pool whose hook is a relaying hook_evil: every buy on it makes the pool
    /// call hook_evil, which forwards the pool's signature to `target` with `victim` as
    /// accounts and `data` as instruction data. Returns the pool and what a swap on it
    /// passes. The pool is made of two fresh mints by a fresh wallet: an attacker needs
    /// nothing from the pool it attacks.
    pub fn relay_pool(&mut self, target: &Pubkey, victim: &[AccountMeta], data: Vec<u8>) -> (Keypair, PoolKeys, HookRef) {
        self.init_evil_relay_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL, target, victim);
        let attacker = self.user(10 * SOL);
        let base = self.create_mint(&attacker, 6);
        let quote = self.create_mint(&attacker, 9);
        self.fund(&attacker, &attacker.insecure_clone(), &base, &quote, 2_000_000_000_000, 2_000 * SOL);
        let k = Self::pool_keys(&base, &quote);
        let cfg = HookRef::cfg(&hook_evil::ID, &k.pool);
        let init = Instruction {
            program_id: hook_evil::ID,
            accounts: hook_evil::accounts::InitPoolConfig { payer: attacker.pubkey(), cfg, system_program: system_program::ID }
                .to_account_metas(None),
            data: hook_evil::instruction::InitPoolConfig { pool: k.pool, mode: hook_evil::MODE_SILENT, value: 0 }.data(),
        };
        self.ok(&[init], &[&attacker]);
        let mut extra = vec![AccountMeta::new(cfg, false), AccountMeta::new_readonly(*target, false)];
        extra.extend(victim.iter().map(|m| AccountMeta { pubkey: m.pubkey, is_signer: false, is_writable: m.is_writable }));
        // no hook fee: the treasury slot is unused
        let hook = HookRef { program: hook_evil::ID, treasury: system_program::ID, extra };
        // the junk pool is created while the hook is silent, then the relay is armed
        let ix = self.create_pool_ix(&attacker.pubkey(), &k, 30, 1_000_000_000_000, 100 * SOL, &hook);
        self.ok(&[compute_budget_ix(400_000), ix], &[&attacker]);
        self.evil_set_relay(&attacker, &k.pool, target, data);
        self.evil_set_mode(&attacker, &k.pool, hook_evil::MODE_RELAY, 0);
        (attacker, k, hook)
    }

    pub fn evil_set_relay(&mut self, payer: &Keypair, pool: &Pubkey, target: &Pubkey, data: Vec<u8>) {
        let cfg = HookRef::cfg(&hook_evil::ID, pool);
        let ix = Instruction {
            program_id: hook_evil::ID,
            accounts: hook_evil::accounts::SetMode { cfg }.to_account_metas(None),
            data: hook_evil::instruction::SetRelay { target: *target, data }.data(),
        };
        self.ok(&[ix], &[payer]);
    }

    pub fn evil_set_mode(&mut self, payer: &Keypair, pool: &Pubkey, mode: u8, value: u64) {
        let cfg = HookRef::cfg(&hook_evil::ID, pool);
        let ix = Instruction {
            program_id: hook_evil::ID,
            accounts: hook_evil::accounts::SetMode { cfg }.to_account_metas(None),
            data: hook_evil::instruction::SetMode { mode, value }.data(),
        };
        self.ok(&[ix], &[payer]);
    }

    /// A ready-made market: fresh mints, a funded creator, a funded trader.
    pub fn market(&mut self) -> Market {
        let authority = self.user(10 * SOL);
        let base_mint = self.create_mint(&authority, 6);
        let quote_mint = self.create_mint(&authority, 9);
        let creator = self.user(10 * SOL);
        let trader = self.user(10 * SOL);
        self.fund(&creator, &authority, &base_mint, &quote_mint, 10_000_000_000_000, 10_000 * SOL);
        self.fund(&trader, &authority, &base_mint, &quote_mint, 1_000_000_000_000, 1_000 * SOL);
        Market { authority, base_mint, quote_mint, creator, trader }
    }
}

pub struct Market {
    pub authority: Keypair,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub creator: Keypair,
    pub trader: Keypair,
}

/// The accounts the launch rules hook keeps for one pool.
#[derive(Clone, Debug)]
pub struct RulesKeys {
    /// The rules and the running numbers. Also the owner of the two vaults.
    pub cfg: Pubkey,
    /// PDA that owns the treasury and the burn account and signs `hook_swap`.
    pub authority: Pubkey,
    /// The authority's quote ATA: the pool's hook treasury.
    pub treasury: Pubkey,
    /// The authority's ATA of the coin: `run_burn` buys into it and burns from it.
    pub burn_account: Pubkey,
    pub stake_vault: Pubkey,
    pub lock: Pubkey,
    pub lock_vault: Pubkey,
}

impl RulesKeys {
    pub fn of(k: &PoolKeys) -> Self {
        let authority = hook_rules::authority_address(&k.pool);
        Self {
            cfg: hook_rules::cfg_address(&k.pool),
            authority,
            treasury: ata(&authority, &k.quote_mint),
            burn_account: ata_with(&authority, &k.base_mint, &k.base_program),
            stake_vault: hook_rules::stake_vault_address(&k.pool),
            lock: hook_rules::lock_address(&k.pool),
            lock_vault: hook_rules::lock_vault_address(&k.pool),
        }
    }
    pub fn stake(k: &PoolKeys, wallet: &Pubkey) -> Pubkey {
        hook_rules::stake_address(&k.pool, wallet)
    }
}

#[derive(Clone, Debug)]
pub struct PoolKeys {
    pub pool: Pubkey,
    /// Token program of the base mint.
    pub base_program: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub lp_lock: Pubkey,
}

/// ComputeBudget::SetComputeUnitLimit. A launch with a hook and a dev buy needs more than 200k CU.
pub fn compute_budget_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

pub fn mark_writable(metas: &mut [AccountMeta], key: &Pubkey) {
    for m in metas.iter_mut() {
        if m.pubkey == *key {
            m.is_writable = true;
        }
    }
}

fn bincode_len(msg: &VersionedMessage) -> usize {
    // VersionedMessage serialises with bincode in the SDK; the test only needs a close
    // upper bound, so count what the wire format counts.
    match msg {
        VersionedMessage::Legacy(m) => {
            3 + 1 + 32 * m.account_keys.len() + 32 + 1
                + m.instructions.iter().map(|ix| 1 + 1 + ix.accounts.len() + 2 + ix.data.len()).sum::<usize>()
        }
        VersionedMessage::V0(m) => {
            1 + 3 + 1 + 32 * m.account_keys.len() + 32 + 1
                + m.instructions.iter().map(|ix| 1 + 1 + ix.accounts.len() + 2 + ix.data.len()).sum::<usize>()
                + 1
        }
    }
}

/// The exact numbers the on-chain program must produce for a swap.
pub fn expect_swap(
    pool: &hookpool::Pool,
    direction: u8,
    amount_in: u64,
    hook_fee_bps: u16,
    fee_override_bps: Option<u16>,
) -> hookpool::math::SwapQuote {
    hookpool::math::quote_swap(
        direction,
        amount_in,
        pool.reserve_base,
        pool.reserve_quote,
        pool.virtual_quote,
        pool.lp_fee_bps,
        PROTOCOL_FEE_BPS,
        hook_fee_bps,
        fee_override_bps,
        None,
    )
    .unwrap()
}
