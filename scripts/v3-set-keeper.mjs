#!/usr/bin/env node
/**
 * Names (or clears) the V3 keeper key on the market core (opcode 64).
 * The core lives wherever it is delegated, so this is sent to the rollup.
 * Signs with the market authority (~/.config/solana/id.json) -- run locally only.
 * Usage: node scripts/v3-set-keeper.mjs <keeper-pubkey | clear | abort-snapshot>
 *        node scripts/v3-set-keeper.mjs reporter <pubkey | clear>   (opcode 66, pre-IPO markets)
 * The market is V3_LIFECYCLE_STATE_PATH's core; the transaction goes to Solana
 * while the core is still there (before delegation), to the rollup after.
 * `abort-snapshot` (opcode 65) closes an unfinished commit snapshot so trading resumes.
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DEFAULT_MAGIC_ER_RPC, DEFAULT_PROGRAM_ID } from "./deployment-manifest.mjs";

const reporterMode = process.argv[2] === "reporter";
const arg = reporterMode ? process.argv[3] : process.argv[2];
if (!arg) throw new Error("usage: v3-set-keeper.mjs <keeper-pubkey | clear | abort-snapshot>");
const state = JSON.parse(fs.readFileSync(process.env.V3_LIFECYCLE_STATE_PATH ?? `${process.env.HOME}/.local/state/stockstream/v3-e2e3-state.json`, "utf8"));
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const key = () => (arg === "clear" ? new Uint8Array(32) : new PublicKey(arg).toBytes());
const data = arg === "abort-snapshot" ? Buffer.from([65]) : Buffer.from([reporterMode ? 66 : 64, ...key()]);
const core = new PublicKey(state.core);
const l1 = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const onL1 = (await l1.getAccountInfo(core))?.owner.equals(new PublicKey(DEFAULT_PROGRAM_ID));
const connection = onL1 ? l1 : new Connection(DEFAULT_MAGIC_ER_RPC, "confirmed");
const tx = new Transaction().add(new TransactionInstruction({
  programId: new PublicKey(DEFAULT_PROGRAM_ID),
  data,
  keys: [{ pubkey: core, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }],
}));
tx.feePayer = authority.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(authority);
const signature = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(signature, "confirmed");
const bytes = (await connection.getAccountInfo(core)).data;
console.log(JSON.stringify({ domain: onL1 ? "solana" : "rollup", signature, keeper: new PublicKey(bytes.subarray(1728, 1760)).toBase58(), reporter: new PublicKey(bytes.subarray(1760, 1792)).toBase58(), commitPhase: bytes[372] }));
