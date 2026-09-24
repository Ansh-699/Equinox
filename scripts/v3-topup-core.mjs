#!/usr/bin/env node
/**
 * Tops up the delegated V3 core's rollup lamports. The core pays MagicBlock
 * commit fees through the magic fee vault (100,000 lamports per account
 * commit past 25 per delegation), so its rollup balance must stay above rent.
 * Sent on the base layer; signs with ~/.config/solana/id.json.
 * Usage: node scripts/v3-topup-core.mjs [sol=1]
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-kit";
import { DEFAULT_MAGIC_ER_RPC } from "./deployment-manifest.mjs";

const sol = Number(process.argv[2] ?? "1");
const state = JSON.parse(fs.readFileSync(process.env.V3_LIFECYCLE_STATE_PATH ?? `${process.env.HOME}/.local/state/stockstream/v3-e2e3-state.json`, "utf8"));
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const core = new PublicKey(state.core);
const salt = crypto.getRandomValues(new Uint8Array(32));
const ix = await lamportsDelegatedTransferIx(payer.publicKey.toBase58(), core.toBase58(), BigInt(Math.round(sol * 1e9)), salt);
// Kit account roles: bit 0 = writable, bit 1 = signer.
const instruction = new TransactionInstruction({
  programId: new PublicKey(ix.programAddress),
  data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isWritable: (a.role & 1) === 1, isSigner: (a.role & 2) === 2 })),
});
const l1 = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const er = new Connection(DEFAULT_MAGIC_ER_RPC, "confirmed");
const before = await er.getBalance(core);
const signature = await sendAndConfirmTransaction(l1, new Transaction().add(instruction), [payer], { commitment: "confirmed", skipPreflight: true });
let after = before;
for (let i = 0; i < 30 && after === before; i += 1) { await new Promise((r) => setTimeout(r, 1000)); after = await er.getBalance(core); }
console.log(JSON.stringify({ signature, rollupLamportsBefore: before, rollupLamportsAfter: after }));
