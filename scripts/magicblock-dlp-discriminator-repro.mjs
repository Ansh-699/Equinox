#!/usr/bin/env node
/**
 * Read-only live reproducer for a DLP discriminator-version mismatch.
 * It submits no transaction; both probes are simulations with throwaway
 * account metas. DLP opcode 0 should reach its handler, while opcode 26 is
 * RequestUndelegation in the vendored API and is rejected by the deployed
 * Devnet DLP before account validation.
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const dlp = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

async function probe(discriminator) {
  const keys = Array.from({ length: 7 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }));
  keys[0] = { pubkey: payer.publicKey, isSigner: true, isWritable: true };
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash })
    .add(new TransactionInstruction({ programId: dlp, keys, data: Buffer.from([discriminator, 0, 0, 0, 0, 0, 0, 0]) }));
  tx.sign(payer);
  const result = await connection.simulateTransaction(tx);
  return { discriminator, error: result.value.err, logs: result.value.logs };
}

console.log(JSON.stringify({
  dlp: dlp.toBase58(),
  requestUndelegation: await probe(26),
  delegateControl: await probe(0),
}, null, 2));
