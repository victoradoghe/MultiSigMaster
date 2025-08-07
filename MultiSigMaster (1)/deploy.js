const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} = require("@solana/web3.js");
const fs = require("fs");

(async () => {
  // Load payer keypair from ANCHOR_WALLET or default local path
  const walletPath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const payerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")))
  );

  // Connect to localnet
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payerKeypair), {});
  anchor.setProvider(provider);

  // Read IDL and program ID
  const idl = JSON.parse(fs.readFileSync("./target/idl/multisig_wallet.json", "utf8"));
  const programId = new PublicKey(idl.metadata.address || "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
  const program = new anchor.Program(idl, programId, provider);

  // Generate extra signers
  const signer1 = Keypair.generate();
  const signer2 = Keypair.generate();

  // Derive multisig PDA and bump
  const [multisigPda, multisigBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), payerKeypair.publicKey.toBuffer()],
    programId
  );

  console.log("Payer:", payerKeypair.publicKey.toBase58());
  console.log("Signer1:", signer1.publicKey.toBase58());
  console.log("Signer2:", signer2.publicKey.toBase58());
  console.log("Multisig PDA:", multisigPda.toBase58());
  console.log("Bump:", multisigBump);

  // Initialize the multisig
  const initialSigners = [
    payerKeypair.publicKey,
    signer1.publicKey,
    signer2.publicKey,
  ];
  const threshold = 2;
  const expiration = null; // optional expiration timestamp

  try {
    const tx = await program.methods
      .initializeMultisig(initialSigners, threshold, expiration, multisigBump)
      .accounts({
        multisig: multisigPda,
        payer: payerKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([payerKeypair])
      .rpc();

    console.log("✅ Multisig initialized successfully:", tx);
  } catch (err) {
    console.error("❌ Error initializing multisig:", err);
  }
})();
