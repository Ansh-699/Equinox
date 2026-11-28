// Top up a market-maker bot's margin in a market that is already delegated (devnet test USDC only).
// The taker crosses the spread on every take, so its realized PnL drains its collateral over days;
// once equity falls under the initial margin the program answers every take with RiskViolation (0x600A).
//
// Same two steps the app's "Deposit" does: USDC to the vault on Solana (inbox receipt, opcode 60),
// then the rollup credits the seat (claim, opcode 61). The bot's key is the local copy of the VM's
// (~/.local/state/stockstream/mm-<bot>.json); test USDC comes from the Worker's operator mint.
//
// Usage: DEV_VARS=/path/to/workers/.dev.vars npx tsx scripts/v3-fund-bot.mts <state-name> <taker|maker> <seat> <usdc>
//   e.g. npx tsx scripts/v3-fund-bot.mts preipo-openai taker 1 25000
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { claimInboxDepositV3, depositToInboxV3 } from "../clients/equinox/src";

const [stateName, botName, seatArg, usdcArg] = process.argv.slice(2);
if (!stateName || !["taker", "maker"].includes(botName) || !seatArg || !usdcArg) throw new Error("usage: v3-fund-bot.mts <state-name> <taker|maker> <seat> <usdc>");
const STATE_DIR = `${process.env.HOME}/.local/state/stockstream`;
const state = JSON.parse(fs.readFileSync(`${STATE_DIR}/${stateName}-state.json`, "utf8"));
const token = /^INGESTION_TOKEN=(.*)$/m.exec(fs.readFileSync(process.env.DEV_VARS ?? "workers/.dev.vars", "utf8"))?.[1]?.replace(/^"|"$/g, "");
if (!token) throw new Error("INGESTION_TOKEN missing from the dev vars file");
const API = process.env.MARKET_API_URL ?? "https://stockstream-market-api.ansht.workers.dev";
const L1 = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const ER = new Connection(process.env.MAGICBLOCK_RPC_URL ?? "https://devnet-as.magicblock.app", "confirmed");

const bot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${STATE_DIR}/mm-${botName}.json`, "utf8"))));
const seat = Number(seatArg);
const units = BigInt(usdcArg) * 1_000_000n;
const core = new PublicKey(state.core), mint = new PublicKey(state.mint), vault = new PublicKey(state.vault);
const { seatShards, eventShards } = state.v3Accounts as { seatShards: string[]; eventShards: string[] };
const seatShard = new PublicKey(seatShards[Math.floor(seat / 32)]);
const source = getAssociatedTokenAddressSync(mint, bot.publicKey);

async function send(label: string, conn: Connection, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = bot.publicKey;
  const latest = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(bot);
  const signature = await conn.sendRawTransaction(tx.serialize());
  const result = await conn.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`${label}: ${JSON.stringify(result.value.err)}`);
  console.log(`${label}: ${signature}`);
}

console.log(`${stateName} ${botName} ${bot.publicKey.toBase58()} seat ${seat}: adding ${usdcArg} test USDC`);
const minted = await fetch(`${API}/v1/operator/mint`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ wallet: bot.publicKey.toBase58(), tokens: units.toString() }) });
if (!minted.ok) throw new Error(`mint: HTTP ${minted.status} ${await minted.text()}`);
console.log("minted");
await send("deposit to inbox (Solana)", L1, [depositToInboxV3({ core, trader: bot.publicKey, source, vault, mint, tokenProgram: TOKEN_PROGRAM_ID }, units)]);
const claim = claimInboxDepositV3({ core, seatShard, eventShards, trader: bot.publicKey }, seat);
// The rollup clones the receipt from Solana; give it a moment to see the new total.
for (let attempt = 0; ; attempt += 1) {
  try {
    await send("claim in the rollup", ER, [claim]);
    break;
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
console.log("done");
