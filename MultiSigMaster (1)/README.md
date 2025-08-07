# Multisig Wallet

A production-ready Solana multisig wallet program built with Anchor. This program allows multiple signers to collectively control a wallet, requiring a threshold number of approvals before executing transactions.

## Features

- **Initialize Multisig**: Create a new multisig wallet with configurable signers and threshold.
- **Propose Transactions**: Any signer can propose a transaction to be executed by the multisig.
- **Approve Transactions**: Signers can approve proposed transactions.
- **Execute Transactions**: Execute transactions once they have enough approvals.
- **Update Multisig Configuration**: Change signers, threshold, or expiration settings.
- **Expiration Support**: Optionally set an expiration time for transactions.

## Account Structure

### MultisigAccount

The main account that stores the multisig configuration:

- `signers`: Array of public keys that can sign transactions
- `threshold`: Number of required approvals to execute a transaction
- `expiration_timestamp`: Optional timestamp after which transactions cannot be approved
- `nonce`: Transaction counter/index
- `bump`: PDA bump seed

### TransactionAccount

Stores information about a proposed transaction:

- `multisig`: The multisig account this transaction belongs to
- `proposer`: The account that proposed this transaction
- `tx_index`: Transaction index/identifier
- `program_id`: Target program to execute
- `accounts`: Serialized account metas for the transaction
- `data`: Instruction data for the transaction
- `signers`: Accounts that have approved this transaction
- `executed`: Whether this transaction has been executed
- `bump`: PDA bump seed

## Instructions

### initialize_multisig

Initialize a new multisig wallet.

**Parameters:**
- `initial_signers`: Initial set of signers for the multisig
- `threshold`: Number of required approvals
- `expiration_timestamp`: Optional expiration timestamp

**Accounts:**
- `multisig`: The multisig account to initialize
- `payer`: The account paying for the transaction
- `system_program`: System Program
- `rent`: Rent Sysvar

### propose_transaction

Propose a new transaction for the multisig to approve.

**Parameters:**
- `program_id`: Target program to execute
- `accounts`: Serialized account metas
- `instruction_data`: Instruction data

**Accounts:**
- `multisig`: The multisig account
- `transaction`: The transaction account to initialize
- `creator`: Creator of the multisig
- `proposer`: The account proposing the transaction
- `system_program`: System Program

### approve_transaction

Approve a proposed transaction.

**Parameters:** None

**Accounts:**
- `multisig`: The multisig account
- `transaction`: The transaction account
- `creator`: Creator of the multisig
- `signer`: The account approving the transaction

### execute_transaction

Execute a transaction that has enough approvals.

**Parameters:** None

**Accounts:**
- `multisig`: The multisig account
- `transaction`: The transaction account
- `creator`: Creator of the multisig
- `remaining_accounts`: All accounts needed for the transaction

### update_multisig

Update the multisig configuration.

**Parameters:**
- `new_signers`: Optional new set of signers
- `new_threshold`: Optional new threshold
- `new_expiration`: Optional new expiration timestamp

**Accounts:**
- `multisig`: The multisig account
- `creator`: Creator of the multisig
- `remaining_accounts`: All current signers must be included and sign

## Error Codes

- `InvalidThreshold`: Threshold must be greater than 0 and less than or equal to the number of signers
- `SignerNotFound`: Signer not found in multisig
- `AlreadyApproved`: Transaction already approved by this signer
- `TransactionExpired`: Transaction has expired
- `InsufficientApprovals`: Not enough approvals to execute transaction
- `TransactionAlreadyExecuted`: Transaction has already been executed
- `NotAllSignersApproved`: Not all current signers have approved the update

## Usage

### Building

```bash
anchor build
```

### Testing

```bash
anchor test
```

### Deploying

```bash
anchor deploy
```

## Security Considerations

- All signers must approve changes to the multisig configuration
- Transactions cannot be executed after they expire
- Transactions cannot be executed more than once
- Only authorized signers can approve transactions
- Threshold validation ensures proper security level

## License

MIT