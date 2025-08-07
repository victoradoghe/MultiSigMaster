import * as anchor from "@coral-xyz/anchor";
import { Program, ProgramError } from "@coral-xyz/anchor";
import { MultisigWallet } from "../target/types/multisig_wallet";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, TransactionInstruction } from "@solana/web3.js";
import { expect } from "chai";

describe("multisig_wallet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MultisigWallet as Program<MultisigWallet>;

  const payer = provider.wallet;
  const signer1 = anchor.web3.Keypair.generate();
  const signer2 = anchor.web3.Keypair.generate();
  const signer3 = anchor.web3.Keypair.generate();
  const newSigner = anchor.web3.Keypair.generate();

  const [multisigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), payer.publicKey.toBuffer()],
    program.programId
  );

  let txIndex = 0;
  let txPda: PublicKey;

  const serializeAccountMetas = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => {
    return keys.map(meta => {
      const pubkeyBytes = meta.pubkey.toBuffer();
      const flags = (meta.isSigner ? 1 : 0) | (meta.isWritable ? 2 : 0);
      return [...pubkeyBytes, flags];
    }).flat();
  };

  const proposeTransaction = async (
    instruction: TransactionInstruction,
    proposer: PublicKey,
    signer?: anchor.web3.Keypair
  ) => {
    const multisigAccount = await program.account.multisigAccount.fetch(multisigPda);
    txIndex = multisigAccount.nonce;

    [txPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tx"), multisigPda.toBuffer(), new anchor.BN(txIndex).toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const accountMetas = serializeAccountMetas(instruction.keys);

    const tx = await program.methods
      .proposeTransaction(instruction.programId, Buffer.from(accountMetas), instruction.data)
      .accounts({
        multisig: multisigPda,
        transaction: txPda,
        creator: payer.publicKey,
        proposer,
        systemProgram: SystemProgram.programId,
      })
      .signers(signer ? [signer] : [])
      .rpc();

    await provider.connection.confirmTransaction(tx);
    return txPda;
  };

  before(async () => {
    const fundTx = new Transaction();

    for (const signer of [signer1, signer2, signer3, newSigner]) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: signer.publicKey,
          lamports: LAMPORTS_PER_SOL * 1,
        })
      );
    }

    const txSig = await provider.sendAndConfirm(fundTx);
    await provider.connection.confirmTransaction(txSig);

    for (const signer of [signer1, signer2, signer3, newSigner]) {
      const balance = await provider.connection.getBalance(signer.publicKey);
      expect(balance).to.be.greaterThan(0);
    }
  });

  after(async () => {
    try {
      const multisigAccount = await program.account.multisigAccount.fetch(multisigPda);
      const tx = await program.methods
        .closeMultisig()
        .accounts({
          multisig: multisigPda,
          creator: payer.publicKey,
          receiver: payer.publicKey,
        })
        .remainingAccounts(multisigAccount.signers.map(pubkey => ({
          pubkey,
          isSigner: true,
          isWritable: false,
        }))))
        .signers([signer1, signer2])
        .rpc();
      await provider.connection.confirmTransaction(tx);
    } catch (error) {
      console.warn("Failed to close multisig account:", error.message);
    }
  });

  it("Initializes a multisig with 3 signers and threshold of 2", async () => {
    const initialSigners = [payer.publicKey, signer1.publicKey, signer2.publicKey];

    const tx = await program.methods
      .initializeMultisig(initialSigners, 2, null)
      .accounts({
        multisig: multisigPda,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await provider.connection.confirmTransaction(tx);

    const multisigAccount = await program.account.multisigAccount.fetch(multisigPda);
    expect(multisigAccount.signers.length).to.equal(3);
    expect(multisigAccount.threshold).to.equal(2);
    expect(multisigAccount.nonce).to.equal(0);
    expect(multisigAccount.expirationTimestamp).to.be.null;
  });

  it("Rejects initialization with invalid threshold", async () => {
    try {
      const tx = await program.methods
        .initializeMultisig([payer.publicKey, signer1.publicKey], 3)
        .accounts({
          multisig: multisigPda,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("InvalidThreshold");
    }
  });

  it("Proposes a transaction", async () => {
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: multisigPda,
      toPubkey: signer3.publicKey,
      lamports: LAMPORTS_PER_SOL / 100,
    });

    await proposeTransaction(transferInstruction, payer.publicKey);

    const txAccount = await program.account.transactionAccount.fetch(txPda);
    expect(txAccount.multisig.toString()).to.equal(multisigPda.toString());
    expect(txAccount.proposer.toString()).to.equal(payer.publicKey.toString());
    expect(txAccount.txIndex).to.equal(txIndex);
    expect(txAccount.programId.toString()).to.equal(SystemProgram.programId.toString());
    expect(txAccount.executed).to.be.false;
    expect(txAccount.signers.length).to.equal(1);
    expect(txAccount.signers[0].toString()).to.equal(payer.publicKey.toString());
  });

  it("Rejects proposal by non-signer", async () => {
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: multisigPda,
      toPubkey: signer3.publicKey,
      lamports: LAMPORTS_PER_SOL / 100,
    });

    try {
      await proposeTransaction(transferInstruction, newSigner.publicKey, newSigner);
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("SignerNotFound");
    }
  });

  it("Approves a transaction by a second signer", async () => {
    const tx = await program.methods
      .approveTransaction()
      .accounts({
        multisig: multisigPda,
        transaction: txPda,
        creator: payer.publicKey,
        signer: signer1.publicKey,
      })
      .signers([signer1])
      .rpc();

    await provider.connection.confirmTransaction(tx);

    const txAccount = await program.account.transactionAccount.fetch(txPda);
    expect(txAccount.signers.length).to.equal(2);
    expect(txAccount.signers[1].toString()).to.equal(signer1.publicKey.toString());
  });

  it("Rejects approval by non-signer", async () => {
    try {
      const tx = await program.methods
        .approveTransaction()
        .accounts({
          multisig: multisigPda,
          transaction: txPda,
          creator: payer.publicKey,
          signer: newSigner.publicKey,
        })
        .signers([newSigner])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("SignerNotFound");
    }
  });

  it("Executes a transaction with sufficient approvals", async () => {
    const txAccount = await program.account.transactionAccount.fetch(txPda);

    const accountMetas = [];
    let i = 0;
    while (i < txAccount.accounts.length) {
      if (i + 33 > txAccount.accounts.length) break;
      const pubkeyBytes = txAccount.accounts.slice(i, i + 32);
      const pubkey = new PublicKey(pubkeyBytes);
      const flags = txAccount.accounts[i + 32];
      const isSigner = (flags & 1) !== 0;
      const isWritable = (flags & 2) !== 0;
      accountMetas.push({ pubkey, isSigner, isWritable });
      i += 33;
    }

    const remainingAccounts = accountMetas.map(meta => ({
      pubkey: meta.pubkey,
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    }));

    const tx = await program.methods
      .executeTransaction()
      .accounts({
        multisig: multisigPda,
        transaction: txPda,
        creator: payer.publicKey,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    await provider.connection.confirmTransaction(tx);

    const updatedTxAccount = await program.account.transactionAccount.fetch(txPda);
    expect(updatedTxAccount.executed).to.be.true;
  });

  it("Rejects execution with insufficient approvals", async () => {
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: multisigPda,
      toPubkey: signer3.publicKey,
      lamports: LAMPORTS_PER_SOL / 100,
    });

    await proposeTransaction(transferInstruction, payer.publicKey);

    const txAccount = await program.account.transactionAccount.fetch(txPda);
    const accountMetas = [];
    let i = 0;
    while (i < txAccount.accounts.length) {
      if (i + 33 > txAccount.accounts.length) break;
      const pubkeyBytes = txAccount.accounts.slice(i, i + 32);
      const pubkey = new PublicKey(pubkeyBytes);
      const flags = txAccount.accounts[i + 32];
      const isSigner = (flags & 1) !== 0;
      const isWritable = (flags & 2) !== 0;
      accountMetas.push({ pubkey, isSigner, isWritable });
      i += 33;
    }

    const remainingAccounts = accountMetas.map(meta => ({
      pubkey: meta.pubkey,
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    }));

    try {
      const tx = await program.methods
        .executeTransaction()
        .accounts({
          multisig: multisigPda,
          transaction: txPda,
          creator: payer.publicKey,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("InsufficientApprovals");
    }
  });

  it("Rejects re-execution of an already executed transaction", async () => {
    const txAccount = await program.account.transactionAccount.fetch(txPda);
    const accountMetas = [];
    let i = 0;
    while (i < txAccount.accounts.length) {
      if (i + 33 > txAccount.accounts.length) break;
      const pubkeyBytes = txAccount.accounts.slice(i, i + 32);
      const pubkey = new PublicKey(pubkeyBytes);
      const flags = txAccount.accounts[i + 32];
      const isSigner = (flags & 1) !== 0;
      const isWritable = (flags & 2) !== 0;
      accountMetas.push({ pubkey, isSigner, isWritable });
      i += 33;
    }

    const remainingAccounts = accountMetas.map(meta => ({
      pubkey: meta.pubkey,
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    }));

    try {
      const tx = await program.methods
        .executeTransaction()
        .accounts({
          multisig: multisigPda,
          transaction: txPda,
          creator: payer.publicKey,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("TransactionAlreadyExecuted");
    }
  });

  it("Tests expiration logic with past timestamp", async () => {
    const slot = await provider.connection.getSlot();
    const timestamp = await provider.connection.getBlockTime(slot);
    const expiration = timestamp - 1000;

    const tx = await program.methods
      .updateMultisig(null, null, new anchor.BN(expiration))
      .accounts({
        multisig: multisigPda,
        creator: payer.publicKey,
      })
      .remainingAccounts([
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: signer1.publicKey, isSigner: true, isWritable: false },
        { pubkey: signer2.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([signer1, signer2])
      .rpc();

    await provider.connection.confirmTransaction(tx);

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: multisigPda,
      toPubkey: signer3.publicKey,
      lamports: LAMPORTS_PER_SOL / 100,
    });

    await proposeTransaction(transferInstruction, payer.publicKey);

    try {
      const tx = await program.methods
        .approveTransaction()
        .accounts({
          multisig: multisigPda,
          transaction: txPda,
          creator: payer.publicKey,
          signer: signer1.publicKey,
        })
        .signers([signer1])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("TransactionExpired");
    }
  });

  it("Tests update_multisig to add/remove signers and change threshold", async () => {
    const multisigAccount = await program.account.multisigAccount.fetch(multisigPda);
    const currentSigners = multisigAccount.signers;
    const newSigners = [...currentSigners, newSigner.publicKey].filter(
      key => !key.equals(signer2.publicKey)
    );

    const tx = await program.methods
      .updateMultisig(newSigners, 2, null)
      .accounts({
        multisig: multisigPda,
        creator: payer.publicKey,
      })
      .remainingAccounts(currentSigners.map(pubkey => ({
        pubkey,
        isSigner: true,
        isWritable: false,
      })))
      .signers([signer1, signer2])
      .rpc();

    await provider.connection.confirmTransaction(tx);

    const updatedMultisigAccount = await program.account.multisigAccount.fetch(multisigPda);
    expect(updatedMultisigAccount.signers.length).to.equal(3);
    expect(updatedMultisigAccount.signers[0].toString()).to.equal(payer.publicKey.toString());
    expect(updatedMultisigAccount.signers[1].toString()).to.equal(signer1.publicKey.toString());
    expect(updatedMultisigAccount.signers[2].toString()).to.equal(newSigner.publicKey.toString());
    expect(updatedMultisigAccount.threshold).to.equal(2);
  });

  it("Rejects update_multisig if not all current signers approve", async () => {
    const multisigAccount = await program.account.multisigAccount.fetch(multisigPda);
    const currentSigners = multisigAccount.signers;

    try {
      const tx = await program.methods
        .updateMultisig(null, 1, null)
        .accounts({
          multisig: multisigPda,
          creator: payer.publicKey,
        })
        .remainingAccounts([
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: newSigner.publicKey, isSigner: true, isWritable: false },
        ])
        .signers([newSigner])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (error) {
      const programError = ProgramError.parse(error, program.idl.errors);
      expect(programError).to.not.be.null;
      expect(programError.name).to.equal("NotAllSignersApproved");
    }
  });
});