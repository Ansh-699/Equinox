#!/usr/bin/env node
/**
 * Minimal live reproducer for MagicBlock's V3 bundle-size rejection.
 * Reads only public keys from the lifecycle checkpoint and never prints keys.
 */
import fs from "node:fs";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const state = JSON.parse(fs.readFileSync("/tmp/opencode/v3-lifecycle-state.json", "utf8"));
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const program = new PublicKey("H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET");
const context = new PublicKey("MagicContext1111111111111111111111111111111");
const magic = new PublicKey("Magic11111111111111111111111111111111111111");
const endpoint = "https://devnet-as.magicblock.app/";
const core = new PublicKey(state.core);
const members = [...state.v3Accounts.bookPages, ...state.v3Accounts.seatShards, ...state.v3Accounts.eventShards].map((key) => new PublicKey(key));

async function rpc(method, params) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const addresses = [core, ...members].map((key) => key.toBase58());
const blockhashResult = await rpc("getBlockhashForAccounts", [addresses]);
const blockhash = (blockhashResult.value ?? blockhashResult).blockhash;
const data = Buffer.alloc(9); data[0] = 14; data.writeBigUInt64LE(1n, 1);
const keys = [
  { pubkey: core, isSigner: false, isWritable: true },
  { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  { pubkey: authority.publicKey, isSigner: true, isWritable: true },
  { pubkey: context, isSigner: false, isWritable: true },
  { pubkey: magic, isSigner: false, isWritable: false },
  ...members.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
];
const transaction = new Transaction({ recentBlockhash: blockhash, feePayer: authority.publicKey });
transaction.add(new TransactionInstruction({ programId: program, keys, data }));
transaction.sign(authority);
const simulation = await rpc("simulateTransaction", [transaction.serialize().toString("base64"), { encoding: "base64", sigVerify: true, replaceRecentBlockhash: false }]);
const result = simulation.value ?? simulation;
console.log(JSON.stringify({
  endpoint,
  program: program.toBase58(),
  opcode: 14,
  sequence: 1,
  bundleAccounts: members.length + 1,
  transactionAccountKeys: keys.length,
  serializedTransactionBytes: transaction.serialize().length,
  contextSlot: simulation.context?.slot,
  err: result.err,
  unitsConsumed: result.unitsConsumed,
  logs: result.logs,
}, null, 2));
