// Serialized InitializeMarket smoke test on Devnet.
// Loads the deploy-authority keypair from the CLI path; never prints secret bytes.
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PROGRAM_ID = process.env.STOCKSTREAM_PROGRAM_ID ?? "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ";
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))));
const market = Keypair.generate();
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const MARKET_SIZE = 222_752;
const rent = await conn.getMinimumBalanceForRentExemption(MARKET_SIZE);

const createIx = SystemProgram.createAccount({
  fromPubkey: authority.publicKey,
  newAccountPubkey: market.publicKey,
  lamports: rent,
  space: MARKET_SIZE,
  programId: new PublicKey(PROGRAM_ID),
});
const initIx = new TransactionInstruction({
  programId: new (await import("@solana/web3.js")).PublicKey(PROGRAM_ID),
  keys: [{ pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }],
  data: Buffer.from([0]),
});
const tx = new (await import("@solana/web3.js")).Transaction().add(createIx, initIx);
const sig = await sendAndConfirmTransaction(conn, tx, [authority, market], { commitment: "confirmed" });
console.log("MARKET_ADDRESS=" + market.publicKey.toBase58());
console.log("SIGNATURE=" + sig);
const slot = await conn.getSlot("finalized");
console.log("CURRENT_SLOT=" + slot);
const info = await conn.getAccountInfo(market.publicKey, "confirmed");
console.log("OWNER=" + info.owner.toBase58());
const data = info.data;
console.log("DISCRIMINATOR=" + Buffer.from(data.slice(0, 8)).toString("latin1"));
console.log("VERSION=" + data.readUInt16LE(8));
console.log("INITIALIZED=" + data[10]);
console.log("MODE=" + data[11]);
console.log("AUTHORITY=" + Buffer.from(data.slice(12, 44)).toString("latin1").startsWith(authority.publicKey.toBase58().slice(0, 20)) ? "matches-authority" : "MISMATCH");
