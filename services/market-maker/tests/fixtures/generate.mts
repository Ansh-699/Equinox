// Regenerates encoding.json from the TypeScript client (the source of truth).
// Run from the repo root: npx tsx services/market-maker/tests/fixtures/generate.mts
import fs from "node:fs";
import { ComputeBudgetProgram, Keypair, Transaction } from "@solana/web3.js";
import { cancelOrderV3, deriveV3ExecutionAccounts, placeOrderV3, replaceOrderV3 } from "../../../../clients/equinox/src";

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const authority = Keypair.fromSeed(seed);
const core = "9Vea9MVZCzYFKNHaHMPET9fuXXjfof8mA2F75pbBDJyV";
const snapshot = "7g5Wz9NfxRzNJbQPvFFf8b8yf8JjRB6W4LnzwxzPi8JE";
const accounts = { ...deriveV3ExecutionAccounts(core, authority.publicKey), authority: authority.publicKey, oracleSnapshot: snapshot };
const key = (0x0246dffa0n << 64n) | 0x2edan;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const place = placeOrderV3({ ...accounts, seatIndex: 3, side: "ask", quantity: 7n, priceOrOffset: 38_012_345n, expiresAt: 1_800_000_000n, clientOrderId: 42n, postOnly: true });
const take = placeOrderV3({ ...accounts, seatIndex: 4, side: "bid", quantity: 2n, priceOrOffset: 38_050_000n, expiresAt: 1_800_000_060n, clientOrderId: 43n, immediateOrCancel: true });
const replace = replaceOrderV3({ ...accounts, oldOrderKey: key, seatIndex: 3, side: "bid", quantity: 5n, priceOrOffset: 38_000_000n, expiresAt: 1_800_000_000n, clientOrderId: 9n, postOnly: true });
const cancel = cancelOrderV3(accounts, 3, key);
const blockhash = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const tx = new Transaction({ feePayer: authority.publicKey, recentBlockhash: blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), replace);
tx.sign(authority);
fs.writeFileSync(new URL("./encoding.json", import.meta.url), JSON.stringify({
  seed: hex(seed), authority: authority.publicKey.toBase58(), core, snapshot, blockhash, orderKey: key.toString(),
  bookPages: accounts.bookPages.map(String), seatShards: accounts.seatShards.map(String), eventShards: accounts.eventShards.map(String),
  place: hex(place.data), take: hex(take.data), replace: hex(replace.data), cancel: hex(cancel.data),
  metas: place.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  transaction: hex(tx.serialize()),
}, null, 2) + "\n");
console.log("wrote encoding.json");
