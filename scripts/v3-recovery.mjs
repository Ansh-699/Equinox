#!/usr/bin/env node
import fs from "node:fs";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const state = JSON.parse(fs.readFileSync("/tmp/opencode/v3-lifecycle-state.json", "utf8"));
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const PROGRAM = new PublicKey("H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ENDPOINT = "https://devnet-as.magicblock.app/";
const core = new PublicKey(state.core);
const pda = (tag) => PublicKey.findProgramAddressSync([Buffer.from(tag), core.toBuffer()], DLP)[0];
const request = pda("undelegation-request");
const record = pda("delegation");
const metadata = pda("delegation-metadata");
const commitState = pda("state-diff");
const commitRecord = pda("commit-state-record");
const mode = process.argv[2] ?? "request";
async function rpc(method, params) {
  const response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json(); if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`); return body.result;
}
const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const wr = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const sg = (pubkey) => ({ pubkey, isSigner: true, isWritable: false });
const ix = mode === "request"
  ? new TransactionInstruction({ programId: PROGRAM, data: Buffer.from([51]), keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, ro(core), ro(PROGRAM), wr(request), ro(record), wr(metadata), ro(PublicKey.default), ro(DLP),
    ] })
  : new TransactionInstruction({ programId: PROGRAM, data: Buffer.from([52]), keys: [
      wr(core), ro(PROGRAM), wr(request), wr(record), wr(metadata), wr(payer.publicKey), wr(commitState), wr(commitRecord), wr(payer.publicKey), ro(DLP),
    ] });
const bh = await rpc("getBlockhashForAccounts", [[core.toBase58(), request.toBase58(), record.toBase58(), metadata.toBase58()]]);
const tx = new Transaction({ recentBlockhash: (bh.value ?? bh).blockhash, feePayer: payer.publicKey }).add(ix); tx.sign(payer);
const raw = tx.serialize();
const sim = await rpc("simulateTransaction", [raw.toString("base64"), { encoding: "base64", sigVerify: true, replaceRecentBlockhash: false }]);
console.log(JSON.stringify({ mode, core: core.toBase58(), request: request.toBase58(), record: record.toBase58(), metadata: metadata.toBase58(), simulation: sim.value ?? sim }, null, 2));
if ((sim.value ?? sim).err) process.exitCode = 1;
else { const signature = await rpc("sendTransaction", [raw.toString("base64"), { encoding: "base64" }]); console.log(JSON.stringify({ signature })); }
