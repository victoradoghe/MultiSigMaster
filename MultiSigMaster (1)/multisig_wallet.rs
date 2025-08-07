use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod multisig_wallet {
    use super::*;

    /// Initializes a new multisig wallet with the specified signers and threshold.
    /// 
    /// # Arguments
    /// - `initial_signers`: List of public keys that can approve transactions.
    /// - `threshold`: Number of approvals required to execute a transaction.
    /// - `expiration_timestamp`: Optional timestamp after which transactions expire.
    pub fn initialize_multisig(
        ctx: Context<InitializeMultisig>,
        initial_signers: Vec<Pubkey>,
        threshold: u8,
        expiration_timestamp: Option<u64>,
    ) -> Result<()> {
        // Validate threshold
        if threshold == 0 || threshold as usize > initial_signers.len() {
            return err!(MultisigWalletError::InvalidThreshold);
        }

        // Initialize multisig account
        let multisig = &mut ctx.accounts.multisig;
        multisig.signers = initial_signers;
        multisig.threshold = threshold;
        multisig.expiration_timestamp = expiration_timestamp;
        multisig.nonce = 0;
        multisig.bump = *ctx.bumps.get("multisig").unwrap();

        Ok(())
    }

    /// Proposes a new transaction for the multisig to approve.
    /// 
    /// # Arguments
    /// - `program_id`: The program ID of the instruction to execute.
    /// - `accounts`: Serialized account metas for the instruction.
    /// - `instruction_data`: The instruction data.
    pub fn propose_transaction(
        ctx: Context<ProposeTransaction>,
        program_id: Pubkey,
        accounts: Vec<u8>,
        instruction_data: Vec<u8>,
    ) -> Result<()> {
        let multisig = &mut ctx.accounts.multisig;
        let transaction = &mut ctx.accounts.transaction;
        let proposer = ctx.accounts.proposer.key();

        // Validate proposer is a signer in the multisig
        if !is_signer_in_multisig(&multisig.signers, &proposer) {
            return err!(MultisigWalletError::SignerNotFound);
        }

        // Validate accounts vector length
        if accounts.len() % 33 != 0 {
            return err!(MultisigWalletError::InvalidAccountMetas);
        }

        // Initialize transaction account
        transaction.multisig = multisig.key();
        transaction.proposer = proposer;
        transaction.tx_index = multisig.nonce;
        transaction.program_id = program_id;
        transaction.accounts = accounts;
        transaction.data = instruction_data;
        transaction.executed = false;
        transaction.bump = *ctx.bumps.get("transaction").unwrap();
        transaction.signers = vec![proposer]; // Proposer auto-approves

        // Increment transaction counter
        multisig.nonce += 1;

        Ok(())
    }

    /// Approves a proposed transaction.
    pub fn approve_transaction(ctx: Context<ApproveTransaction>) -> Result<()> {
        let multisig = &ctx.accounts.multisig;
        let transaction = &mut ctx.accounts.transaction;
        let signer = ctx.accounts.signer.key();

        // Check if transaction has expired
        if let Some(expiration) = multisig.expiration_timestamp {
            let clock = Clock::get()?;
            if clock.unix_timestamp >= 0 && (clock.unix_timestamp as u64) > expiration {
                return err!(MultisigWalletError::TransactionExpired);
            }
        }

        // Check if signer is in multisig
        if !is_signer_in_multisig(&multisig.signers, &signer) {
            return err!(MultisigWalletError::SignerNotFound);
        }

        // Check if signer has already approved
        if transaction.signers.contains(&signer) {
            return err!(MultisigWalletError::AlreadyApproved);
        }

        // Add signer to approvals
        transaction.signers.push(signer);

        Ok(())
    }

    /// Executes a transaction that has enough approvals.
    pub fn execute_transaction(ctx: Context<ExecuteTransaction>) -> Result<()> {
        let multisig = &ctx.accounts.multisig;
        let transaction = &mut ctx.accounts.transaction;

        // Check if transaction has already been executed
        if transaction.executed {
            return err!(MultisigWalletError::TransactionAlreadyExecuted);
        }

        // Check if there are enough approvals
        if transaction.signers.len() < multisig.threshold as usize {
            return err!(MultisigWalletError::InsufficientApprovals);
        }

        // Deserialize account metas
        let account_metas = deserialize_account_metas(&transaction.accounts)?;

        // Validate remaining accounts
        if ctx.remaining_accounts.len() < account_metas.len() {
            return err!(MultisigWalletError::InsufficientAccounts);
        }

        // Create remaining accounts array
        let mut invoke_accounts = Vec::with_capacity(account_metas.len());
        for (i, meta) in account_metas.iter().enumerate() {
            let account = ctx.remaining_accounts.get(i).ok_or(MultisigWalletError::InsufficientAccounts)?;
            if account.key() != meta.pubkey {
                return err!(MultisigWalletError::InvalidAccountMetas);
            }
            invoke_accounts.push(AccountMeta {
                pubkey: account.key(),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            });
        }

        // Prevent recursive CPI to this program
        if transaction.program_id == ctx.program_id {
            return err!(MultisigWalletError::RecursiveCallNotAllowed);
        }

        // Create instruction
        let instruction = Instruction {
            program_id: transaction.program_id,
            accounts: invoke_accounts,
            data: transaction.data.clone(),
        };

        // Get PDA signer
        let multisig_key = multisig.key();
        let seeds = &[
            b"multisig".as_ref(),
            ctx.accounts.creator.key.as_ref(),
            &[multisig.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Execute transaction via CPI
        invoke_signed(&instruction, ctx.remaining_accounts, signer_seeds)?;

        // Mark transaction as executed
        transaction.executed = true;

        Ok(())
    }

    /// Updates the multisig configuration (signers, threshold, or expiration).
    pub fn update_multisig(
        ctx: Context<UpdateMultisig>,
        new_signers: Option<Vec<Pubkey>>,
        new_threshold: Option<u8>,
        new_expiration: Option<u64>,
    ) -> Result<()> {
        let multisig = &mut ctx.accounts.multisig;

        // Verify all current signers have approved
        for signer in &multisig.signers {
            let found = ctx.remaining_accounts.iter().any(|account| {
                account.key() == *signer && account.is_signer
            });
            if !found {
                return err!(MultisigWalletError::NotAllSignersApproved);
            }
        }

        // Update signers if provided
        if let Some(signers) = new_signers {
            multisig.signers = signers;
        }

        // Update threshold if provided
        if let Some(threshold) = new_threshold {
            if threshold == 0 || threshold as usize > multisig.signers.len() {
                return err!(MultisigWalletError::InvalidThreshold);
            }
            multisig.threshold = threshold;
        }

        // Update expiration if provided
        multisig.expiration_timestamp = new_expiration;

        Ok(())
    }

    /// Closes the multisig account and transfers lamports to the receiver.
    pub fn close_multisig(ctx: Context<CloseMultisig>) -> Result<()> {
        let multisig = &mut ctx.accounts.multisig;
        let receiver = &mut ctx.accounts.receiver;

        // Verify all current signers have approved
        for signer in &multisig.signers {
            let found = ctx.remaining_accounts.iter().any(|account| {
                account.key() == *signer && account.is_signer
            });
            if !found {
                return err!(MultisigWalletError::NotAllSignersApproved);
            }
        }

        // Transfer lamports to receiver
        let multisig_lamports = multisig.to_account_info().lamports();
        **multisig.to_account_info().lamports.borrow_mut() = 0;
        **receiver.to_account_info().lamports.borrow_mut() += multisig_lamports;

        Ok(())
    }
}

// Helper function to check if a signer is in the multisig
fn is_signer_in_multisig(signers: &[Pubkey], signer: &Pubkey) -> bool {
    signers.contains(signer)
}

// Helper function to deserialize account metas
fn deserialize_account_metas(data: &[u8]) -> Result<Vec<AccountMeta>> {
    if data.len() % 33 != 0 {
        return err!(MultisigWalletError::InvalidAccountMetas);
    }

    let mut account_metas = Vec::with_capacity(data.len() / 33);
    let mut i = 0;

    while i < data.len() {
        let pubkey_bytes = data.get(i..i + 32).ok_or(MultisigWalletError::InvalidAccountMetas)?;
        let pubkey = Pubkey::new_from_array(pubkey_bytes.try_into().unwrap());
        let flags = *data.get(i + 32).ok_or(MultisigWalletError::InvalidAccountMetas)?;
        let is_signer = (flags & 1) != 0;
        let is_writable = (flags & 2) != 0;

        account_metas.push(AccountMeta {
            pubkey,
            is_signer,
            is_writable,
        });

        i += 33;
    }

    Ok(account_metas)
}

#[derive(Accounts)]
#[instruction(initial_signers: Vec<Pubkey>, threshold: u8, expiration_timestamp: Option<u64>)]
pub struct InitializeMultisig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + // discriminator
                4 + (initial_signers.len() * 32) + // signers vector
                1 + // threshold
                9 + // optional expiration timestamp
                8 + // nonce
                1,  // bump
        seeds = [b"multisig", payer.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(program_id: Pubkey, accounts: Vec<u8>, instruction_data: Vec<u8>)]
pub struct ProposeTransaction<'info> {
    #[account(
        mut,
        seeds = [b"multisig", creator.key().as_ref()],
        bump = multisig.bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    #[account(
        init,
        payer = proposer,
        space = 8 + // discriminator
                32 + // multisig pubkey
                32 + // proposer pubkey
                8 +  // tx_index
                32 + // program_id
                4 + accounts.len() + // accounts vector
                4 + instruction_data.len() + // data vector
                4 + (multisig.signers.len() * 32) + // signers vector (dynamic)
                1 + // executed
                1,  // bump
        seeds = [b"tx", multisig.key().as_ref(), &multisig.nonce.to_le_bytes()],
        bump
    )]
    pub transaction: Account<'info, TransactionAccount>,
    
    /// CHECK: This is just used as a seed for the multisig PDA
    pub creator: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub proposer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveTransaction<'info> {
    #[account(
        seeds = [b"multisig", creator.key().as_ref()],
        bump = multisig.bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    #[account(
        mut,
        seeds = [b"tx", multisig.key().as_ref(), &transaction.tx_index.to_le_bytes()],
        bump = transaction.bump,
        constraint = transaction.multisig == multisig.key()
    )]
    pub transaction: Account<'info, TransactionAccount>,
    
    /// CHECK: This is just used as a seed for the multisig PDA
    pub creator: UncheckedAccount<'info>,
    
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTransaction<'info> {
    #[account(
        seeds = [b"multisig", creator.key().as_ref()],
        bump = multisig.bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    #[account(
        mut,
        seeds = [b"tx", multisig.key().as_ref(), &transaction.tx_index.to_le_bytes()],
        bump = transaction.bump,
        constraint = transaction.multisig == multisig.key()
    )]
    pub transaction: Account<'info, TransactionAccount>,
    
    /// CHECK: This is just used as a seed for the multisig PDA
    pub creator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateMultisig<'info> {
    #[account(
        mut,
        seeds = [b"multisig", creator.key().as_ref()],
        bump = multisig.bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    /// CHECK: This is just used as a seed for the multisig PDA
    pub creator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseMultisig<'info> {
    #[account(
        mut,
        seeds = [b"multisig", creator.key().as_ref()],
        bump = multisig.bump,
        close = receiver
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    /// CHECK: This is just used as a seed for the multisig PDA
    pub creator: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub receiver: AccountInfo<'info>,
}

#[account]
pub struct MultisigAccount {
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub expiration_timestamp: Option<u64>,
    pub nonce: u64,
    pub bump: u8,
}

#[account]
pub struct TransactionAccount {
    pub multisig: Pubkey,
    pub proposer: Pubkey,
    pub tx_index: u64,
    pub program_id: Pubkey,
    pub accounts: Vec<u8>,
    pub data: Vec<u8>,
    pub signers: Vec<Pubkey>,
    pub executed: bool,
    pub bump: u8,
}

#[error_code]
pub enum MultisigWalletError {
    #[msg("Threshold must be greater than 0 and less than or equal to the number of signers")]
    InvalidThreshold,
    #[msg("Signer not found in multisig")]
    SignerNotFound,
    #[msg("Transaction already approved by this signer")]
    AlreadyApproved,
    #[msg("Transaction has expired")]
    TransactionExpired,
    #[msg("Not enough approvals to execute transaction")]
    InsufficientApprovals,
    #[msg("Transaction has already been executed")]
    TransactionAlreadyExecuted,
    #[msg("Not all current signers have approved the update")]
    NotAllSignersApproved,
    #[msg("Invalid account metas provided")]
    InvalidAccountMetas,
    #[msg("Insufficient accounts provided for execution")]
    InsufficientAccounts,
    #[msg("Recursive CPI calls are not allowed")]
    RecursiveCallNotAllowed,
}