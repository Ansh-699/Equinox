// Seats and collateral for the market-maker bots in a new market, on Solana,
// before delegation (delegation requires a funded seat). The bots' keys are the
// local copies of the VM's (~/.local/state/stockstream/mm-{maker,taker}.json);
// test USDC comes from the Worker's operator mint (INGESTION_TOKEN, workers/.dev.vars).
// Usage: npx tsx scripts/preipo-bots.mts <state-name>   e.g. preipo-openai
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createV3TraderSeat, depositCollateralV3 } from "../clients/stockstream/src";

const STATE_DIR = `${process.env.HOME}/.local/state/stockstream`;
const state = JSON.parse(fs.readFileSync(`${STATE_DIR}/${process.argv[2] ?? ""}-state.json`, "utf8"));
const token = /^INGESTION_TOKEN=(.*)$/m.exec(fs.readFileSync("workers/.dev.vars", "utf8"))?.[1]?.replace(/^"|"$/g, "");
if (!token) throw new Error("INGESTION_TOKEN missing from workers/.dev.vars");
const API = process.env.MARKET_API_URL ?? "https://stockstream-market-api.ansht.workers.dev";
const l1 = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${STATE_DIR}/mm-${name}.json`, "utf8"))));
const core = new PublicKey(state.core), mint = new PublicKey(state.mint), vault = new PublicKey(state.vault), snapshot = new PublicKey(state.oracleSnapshot);
const { seatShards, eventShards } = state.v3Accounts as { seatShards: string[]; eventShards: string[] };

async function send(name: string, ixs: TransactionInstruction[], signer: Keypair) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey;
  const latest = await l1.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const signature = await l1.sendRawTransaction(tx.serialize());
  const result = await l1.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`${name}: ${JSON.stringify(result.value.err)}`);
  console.log(`${name}: ${signature}`);
}

// Seat 0 maker, seat 1 taker; USDC sized so the maker's ladder rests without running out of margin.
for (const [seat, name, usdc] of [[0, "maker", 50_000n], [1, "taker", 5_000n]] as const) {
  const bot = key(name);
  const shard = new PublicKey(seatShards[0]);
  const occupied = (await l1.getAccountInfo(shard))!.data[44 + seat * 256] === 1;
  if (!occupied) await send(`${name} seat`, [createV3TraderSeat({ core, seatShards, eventShards, trader: bot.publicKey }, seat)], bot);
  const ata = getAssociatedTokenAddressSync(mint, bot.publicKey);
  const units = usdc * 1_000_000n;
  const minted = await fetch(`${API}/v1/operator/mint`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ wallet: bot.publicKey.toBase58(), tokens: units.toString() }) });
  if (!minted.ok) throw new Error(`mint for ${name}: HTTP ${minted.status} ${await minted.text()}`);
  console.log(`${name}: minted ${usdc} test USDC`);
  // The program checks a fresh price: the reporter posts every few seconds.
  await send(`${name} deposit`, [depositCollateralV3({ core, seatShard: shard, eventShards, authority: bot.publicKey, source: ata, vault, mint, tokenProgram: TOKEN_PROGRAM_ID, oracleSnapshot: snapshot }, seat, units)], bot);
}
