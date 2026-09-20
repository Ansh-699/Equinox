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
const REQUEST_UNDELEGATION_DISCRIMINATOR = 26;
const REQUEST_UNDELEGATION_DATA = Buffer.alloc(8);
REQUEST_UNDELEGATION_DATA.writeBigUInt64LE(BigInt(REQUEST_UNDELEGATION_DISCRIMINATOR));
const REQUEST_UNDELEGATION_DATA_HEX = REQUEST_UNDELEGATION_DATA.toString("hex");
const REQUEST_UNDELEGATION_ACCOUNT_SCHEMA = [
  ["delegation_rent_payer", true, true],
  ["delegated_account", true, false],
  ["owner_program", false, false],
  ["undelegation_request_pda", false, true],
  ["delegation_record_pda", false, false],
  ["delegation_metadata_pda", false, true],
  ["system_program", false, false],
];

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
  vendoredContract: {
    crate: "magicblock-delegation-program-api 3.1.0",
    discriminator: REQUEST_UNDELEGATION_DISCRIMINATOR,
    dataHex: REQUEST_UNDELEGATION_DATA_HEX,
    accounts: REQUEST_UNDELEGATION_ACCOUNT_SCHEMA.map(([role, signer, writable]) => ({ role, signer, writable })),
  },
  requestUndelegation: await probe(REQUEST_UNDELEGATION_DISCRIMINATOR),
  delegateControl: await probe(0),
}, null, 2));
