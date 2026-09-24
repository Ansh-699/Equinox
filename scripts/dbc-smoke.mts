// Devnet smoke test of the USD-priced Meteora DBC launch: create a quick-graduate
// pool, buy on the curve, read it, buy through the graduation threshold.
// A throwaway creator gets 0.08 SOL from the local authority and test USDC from
// the operator mint. Run: npx tsx --tsconfig tsconfig.json scripts/dbc-smoke.mts
import fs from "node:fs";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { LAUNCH_PRESETS, buildLaunchTransaction, buildSwapTransaction, readPool } from "../features/launch/dbc-launch";

const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const creator = Keypair.generate();
const token = /^INGESTION_TOKEN=(.*)$/m.exec(fs.readFileSync("workers/.dev.vars", "utf8"))![1].replace(/^"|"$/g, "");
await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: creator.publicKey, lamports: 80_000_000 })), [authority]);
const minted = await fetch("https://stockstream-market-api.ansht.workers.dev/v1/operator/mint", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ wallet: creator.publicKey.toBase58(), tokens: String(5_000n * 1_000_000n) }) });
console.log("creator", creator.publicKey.toBase58(), "mint", minted.status);

const send = async (tx: Transaction, lastValidBlockHeight: number) => {
  tx.partialSign(creator);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`${signature}: ${JSON.stringify(result.value.err)}`);
  return signature;
};
const preset = LAUNCH_PRESETS.find((p) => p.id === "devnet")!;
const before = await connection.getBalance(creator.publicKey);
const launch = await buildLaunchTransaction(connection, { name: "Smoke Equity", symbol: "SMOKE", uri: "https://equinox.ansht.workers.dev/brand/equinox-dark.png", preset, creator: creator.publicKey });
console.log("launch", await send(launch.transaction, launch.lastValidBlockHeight), "pool", launch.pool.toBase58(), "cost SOL", (before - await connection.getBalance(creator.publicKey)) / 1e9);
fs.writeFileSync(`${process.env.HOME}/.local/state/stockstream/dbc-smoke.json`, JSON.stringify({ pool: launch.pool.toBase58(), mint: launch.baseMint.toBase58(), creator: [...creator.secretKey] }), { mode: 0o600 });
console.log("fresh", await readPool(connection, launch.pool));
const buy = async (usd: number) => { const swap = await buildSwapTransaction(connection, { owner: creator.publicKey, pool: launch.pool, side: "buy", amount: usd, slippageBps: 500 }); return send(swap.transaction, swap.lastValidBlockHeight); };
console.log("buy $100", await buy(100));
const after = await readPool(connection, launch.pool);
console.log("after $100", after);
const remaining = Math.ceil((after.thresholdUsd - after.raisedUsd) * 1.05);
console.log(`buy $${remaining} to graduate`, await buy(remaining).catch((e: Error) => `failed: ${e.message.slice(0, 300)}`));
console.log("final", await readPool(connection, launch.pool));
