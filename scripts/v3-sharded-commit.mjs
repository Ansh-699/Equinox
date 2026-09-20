#!/usr/bin/env node
/**
 * Resumable V3 shard commit runner.
 * MagicBlock's deployed scheduler accepts each bounded child as a one-account
 * intent, but rejects the complete 27-account intent as 0xa0000002. The core
 * sequence is advanced by StockStream across these calls and is committed last.
 */
import fs from "node:fs";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { validateCheckpoint, validateV3CommitEpoch, validateV3CoreBytes } from "./v3-sharded-commit-guard.mjs";

const LIFECYCLE_STATE_PATH = process.env.V3_LIFECYCLE_STATE_PATH ?? "/tmp/opencode/v3-lifecycle-state.json";
const state = JSON.parse(fs.readFileSync(LIFECYCLE_STATE_PATH, "utf8"));
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const PROGRAM = new PublicKey("H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const ENDPOINT = "https://devnet-as.magicblock.app/";
const core = new PublicKey(state.core);
const children = [...state.v3Accounts.bookPages, ...state.v3Accounts.seatShards, ...state.v3Accounts.eventShards].map((key) => new PublicKey(key));
const mode = process.argv[2] ?? "commit";
if (!new Set(["commit", "undelegate"]).has(mode)) throw new Error("usage: v3-sharded-commit.mjs [commit|undelegate]");

async function rpc(method, params) {
  const response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

function save(path, value) { fs.writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); }
function load(path, initial) { return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : initial; }

async function submit(account, sequence, undelegate) {
  const blockhashResult = await rpc("getBlockhashForAccounts", [[account.toBase58(), core.toBase58()]]);
  const tx = new Transaction({ recentBlockhash: (blockhashResult.value ?? blockhashResult).blockhash, feePayer: authority.publicKey });
  const data = Buffer.alloc(9); data[0] = undelegate ? 15 : 14; data.writeBigUInt64LE(BigInt(sequence), 1);
  tx.add(new TransactionInstruction({ programId: PROGRAM, data, keys: [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
    { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: core, isSigner: false, isWritable: true },
  ] }));
  tx.sign(authority);
  const raw = tx.serialize();
  const simulation = await rpc("simulateTransaction", [raw.toString("base64"), { encoding: "base64", sigVerify: true, replaceRecentBlockhash: false }]);
  if ((simulation.value ?? simulation).err) throw new Error(`simulation: ${JSON.stringify(simulation.value ?? simulation)}`);
  const signature = await rpc("sendTransaction", [raw.toString("base64"), { encoding: "base64" }]);
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const status = (await rpc("getSignatureStatuses", [[signature]])).value?.[0];
    if (status?.err) throw new Error(`transaction ${signature}: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "finalized") return { signature, slot: status.slot };
  }
  throw new Error(`finality timeout for ${signature}`);
}

const undelegate = mode === "undelegate";
const path = process.env.V3_SHARDED_COMMIT_STATE_PATH ?? `/tmp/opencode/v3-sharded-${mode}-state.json`;
const checkpoint = load(path, { version: 1, next: 0, events: [] });
checkpoint.mode ??= mode;
validateCheckpoint(checkpoint, mode, children);
if (checkpoint.complete) {
  console.log(JSON.stringify({ mode, checkpoint: path, complete: true, next: checkpoint.next, core: checkpoint.core ?? null }));
  process.exit(0);
}
const coreInfo = (await rpc("getAccountInfo", [core.toBase58(), { encoding: "base64" }])).value;
if (!coreInfo) throw new Error("V3 core is not present on the resolved ER");
const coreBytes = Buffer.from(coreInfo.data[0], "base64");
validateV3CoreBytes(coreBytes);
const firstSequence = Number(coreBytes.readBigUInt64LE(198));
if (checkpoint.epoch === undefined) checkpoint.epoch = firstSequence - checkpoint.next;
if (checkpoint.epoch !== firstSequence - checkpoint.next) {
  throw new Error(`V3 sharded checkpoint epoch mismatch: checkpoint=${checkpoint.epoch} observed=${firstSequence} next=${checkpoint.next}`);
}
for (let index = checkpoint.next; index < children.length; index += 1) {
  const current = (await rpc("getAccountInfo", [core.toBase58(), { encoding: "base64" }])).value;
  if (!current) throw new Error("V3 core disappeared during sharded commit");
  const currentBytes = Buffer.from(current.data[0], "base64");
  validateV3CommitEpoch(currentBytes, checkpoint.epoch + index);
  const sequence = checkpoint.epoch + index;
  const result = await submit(children[index], sequence, undelegate);
  checkpoint.events.push({ index, child: children[index].toBase58(), sequence, ...result });
  checkpoint.next = index + 1; save(path, checkpoint); console.log(JSON.stringify(checkpoint.events.at(-1)));
}
const coreSequence = checkpoint.epoch + children.length;
const coreResult = await submit(core, coreSequence, undelegate);
checkpoint.core = { sequence: coreSequence, ...coreResult }; checkpoint.complete = true; save(path, checkpoint); console.log(JSON.stringify(checkpoint.core));
