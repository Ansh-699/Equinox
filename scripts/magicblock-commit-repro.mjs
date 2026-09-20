#!/usr/bin/env node
/**
 * Read-only MagicBlock CommitMarket reproducer.
 *
 * It never sends a transaction.  It derives the already-created hot cluster
 * from the checkpoint selected by MAGICBLOCK_REPRO_STATE_PATH (default
 * /tmp/opencode/lifecycle-state.json), signs a simulation with the
 * existing market authority, and writes redacted diagnostic evidence.  This
 * lets us distinguish a caller ABI mistake from an ER-validator rejection
 * without recreating, committing, or undelegating any checkpoint account.
 */
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";

const ROUTER = "https://devnet-router.magicblock.app";
const PROGRAM_ID = new PublicKey("H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const STATE_PATH = process.env.MAGICBLOCK_REPRO_STATE_PATH ?? "/tmp/opencode/lifecycle-state.json";
const OUTPUT_PATH = process.argv[2] ?? "/tmp/opencode/magicblock-commit-simulation.json";

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
for (const name of ["market", "sessionA", "sessionB"]) {
  if (typeof state[name] !== "string") throw new Error(`checkpoint missing ${name}`);
}
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"),
)));
const market = new PublicKey(state.market);
const scratch = (seat) => PublicKey.findProgramAddressSync([
  Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0]),
], PROGRAM_ID)[0];
const cluster = [market, scratch(0), scratch(1), new PublicKey(state.sessionA), new PublicKey(state.sessionB)];

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const status = await rpc(ROUTER, "getDelegationStatus", [market.toBase58()]);
if (!status?.isDelegated || typeof status.fqdn !== "string") throw new Error("checkpoint market is not currently delegated");
const endpoint = status.fqdn.replace(/\/$/, "");
const blockhashResult = await rpc(endpoint, "getBlockhashForAccounts", [cluster.map((a) => a.toBase58())]);
const recentBlockhash = (blockhashResult.value ?? blockhashResult).blockhash;
if (typeof recentBlockhash !== "string") throw new Error("ER returned no account-aware blockhash");

const metas = [
  { pubkey: market, isSigner: false, isWritable: true, role: "market" },
  { pubkey: authority.publicKey, isSigner: true, isWritable: false, role: "authority" },
  { pubkey: authority.publicKey, isSigner: true, isWritable: true, role: "payer" },
  { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true, role: "magic_context" },
  { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false, role: "magic_program" },
  ...cluster.slice(1).map((pubkey, index) => ({ pubkey, isSigner: false, isWritable: true, role: `member_${index}` })),
];
const data = Buffer.alloc(9);
data[0] = 14; // CommitMarket
data.writeBigUInt64LE(BigInt(state.commitSequence ?? 1), 1);
const tx = new Transaction({ recentBlockhash, feePayer: authority.publicKey }).add(new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: metas.map(({ pubkey, isSigner, isWritable }) => ({ pubkey, isSigner, isWritable })),
  data,
}));
tx.sign(authority);
const encoded = tx.serialize().toString("base64");
const simulation = await rpc(endpoint, "simulateTransaction", [encoded, {
  encoding: "base64", sigVerify: true, replaceRecentBlockhash: false,
  commitment: "processed",
}]);

const infos = await Promise.all(metas.map(async ({ pubkey, role }) => {
  const result = await rpc(endpoint, "getAccountInfo", [pubkey.toBase58(), { encoding: "base64" }]);
  const value = result?.value;
  return {
    role, address: pubkey.toBase58(), exists: value !== null,
    owner: value?.owner ?? null, executable: value?.executable ?? null,
    dataLength: value?.data?.[0] ? Buffer.from(value.data[0], "base64").length : null,
  };
}));
const evidence = {
  generatedAt: new Date().toISOString(), readOnly: true, endpoint,
  delegation: { isDelegated: status.isDelegated, authority: status.delegationRecord?.authority ?? null, delegationSlot: status.delegationRecord?.delegationSlot ?? null },
  program: PROGRAM_ID.toBase58(), instruction: { opcode: 14, dataHex: data.toString("hex"), dataLength: data.length },
  accountMetas: metas.map(({ pubkey, isSigner, isWritable, role }) => ({ role, address: pubkey.toBase58(), isSigner, isWritable })),
  accounts: infos,
  simulation: simulation.value ?? simulation,
};
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output: OUTPUT_PATH, err: evidence.simulation?.err ?? null, logs: evidence.simulation?.logs ?? [] }, null, 2));
