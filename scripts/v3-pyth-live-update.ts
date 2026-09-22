#!/usr/bin/env node
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { loadPythKeeperConfig, PythKeeper } from "../lib/server/pyth-keeper";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM = "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ";
const CORE = process.env.V3_CORE;
const STATE_PATH = process.env.V3_LIFECYCLE_STATE_PATH ?? "/tmp/opencode/v3-lifecycle-state.json";
const PYTH_PROGRAM = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
const PYTH_STORAGE = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";
const EXPECTED = { symbol: "Equity.US.TSLA/USD", feedId: 1435, channel: "fixed_rate@50ms", channelId: 2, exponent: -5 } as const;
const execute = process.argv.includes("--submit");

if (execute && process.env.CONFIRM_TSLA_PYTH_UPDATE !== "1") {
  throw new Error("submission requires CONFIRM_TSLA_PYTH_UPDATE=1 after explicit transaction approval");
}
if (!CORE) throw new Error("V3_CORE is required (the fresh revision-2 core address)");
if (!fs.existsSync(STATE_PATH)) throw new Error(`missing TSLA lifecycle checkpoint: ${STATE_PATH}`);
const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
if (state.core !== CORE || state.v3Accounts?.eventShards?.length !== 4) throw new Error("checkpoint is not the verified isolated TSLA bundle");

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
if (payer.publicKey.toBase58() !== "A5sV4PkkVM4gm3rejACvKFgxEMmj8ouGsffSKT5qYVc8") throw new Error("unexpected keeper authority");
const connection = new Connection(RPC, "confirmed");
const storageInfo = await connection.getAccountInfo(new PublicKey(PYTH_STORAGE), "confirmed");
if (!storageInfo || storageInfo.data.length < 72 || storageInfo.owner.toBase58() !== PYTH_PROGRAM) throw new Error("invalid deployed Pyth storage account");
const pythTreasury = new PublicKey(storageInfo.data.subarray(40, 72));
if (!(await connection.getAccountInfo(pythTreasury, "confirmed"))) throw new Error("deployed Pyth treasury pointer does not resolve");
const endpoints = process.env.PYTH_PRO_ENDPOINTS || [0, 1, 2].map((index) => `wss://pyth-lazer-${index}.dourolabs.app/v1/stream`).join(",");
const config = loadPythKeeperConfig({
  ...process.env,
  PYTH_PRO_FEED_ID: String(EXPECTED.feedId),
  PYTH_PRO_MIN_CHANNEL: EXPECTED.channel,
  PYTH_PRO_ENDPOINTS: endpoints,
  STOCKSTREAM_MARKET_ADDRESS: CORE,
  KEEPER_PUBLIC_KEY: payer.publicKey.toBase58(),
  PYTH_PROGRAM_ADDRESS: PYTH_PROGRAM,
  PYTH_STORAGE_ADDRESS: PYTH_STORAGE,
  PYTH_TREASURY_ADDRESS: pythTreasury.toBase58(),
});
const keeper = new PythKeeper(config);
const update = await keeper.fetchSignedUpdate();
const parsed = update.parsed as typeof update.parsed & { price?: string; exponent?: number; confidence?: number | string; marketSession?: string; feedUpdateTimestamp?: number | string };
if (update.feedId !== EXPECTED.feedId) throw new Error("wrong feed in signed Pyth update");
if (parsed.exponent !== EXPECTED.exponent) throw new Error("wrong exponent in signed Pyth update");
const feedTimestampUs = BigInt(parsed.feedUpdateTimestamp ?? 0);
const nowUs = BigInt(Date.now()) * 1_000n;
const ageUs = nowUs - feedTimestampUs;
if (feedTimestampUs <= 0n || ageUs < -2_000_000n || ageUs > 10_000_000n) throw new Error("signed Pyth update is stale or future-dated");

const instructions = keeper.buildV3Transaction(update, {
  core: CORE,
  eventShards: state.v3Accounts.eventShards,
  payer: payer.publicKey,
  pythProgram: PYTH_PROGRAM,
  storage: PYTH_STORAGE,
  treasury: pythTreasury,
  systemProgram: SystemProgram.programId,
  instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
});
const transaction = new Transaction().add(...instructions);
const latestBlockhash = await connection.getLatestBlockhash("confirmed");
transaction.feePayer = payer.publicKey;
transaction.recentBlockhash = latestBlockhash.blockhash;
transaction.sign(payer);
const balanceAddresses = [payer.publicKey, pythTreasury];
const balancesBefore = await connection.getMultipleAccountsInfo(balanceAddresses, "confirmed");
const simulationResponse = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "simulateTransaction",
    params: [transaction.serialize().toString("base64"), {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: true,
      accounts: { encoding: "base64", addresses: balanceAddresses.map((address) => address.toBase58()) },
    }],
  }),
});
const simulationJson = await simulationResponse.json() as { result?: { value?: { err: unknown; unitsConsumed?: number; logs?: string[]; accounts?: Array<{ lamports: number } | null> } }; error?: unknown };
if (!simulationResponse.ok || simulationJson.error || !simulationJson.result?.value) throw new Error(`simulation RPC failed: ${JSON.stringify(simulationJson.error ?? simulationResponse.status)}`);
const simulation = simulationJson.result.value;
const simulatedAccounts = simulation.accounts ?? [];
const lamportDeltas = balanceAddresses.map((address, index) => ({
  address: address.toBase58(),
  before: balancesBefore[index]?.lamports ?? 0,
  after: simulatedAccounts[index]?.lamports ?? 0,
  delta: (simulatedAccounts[index]?.lamports ?? 0) - (balancesBefore[index]?.lamports ?? 0),
}));
const plan = {
  cluster: "devnet",
  execute,
  programId: PROGRAM,
  feePayer: payer.publicKey.toBase58(),
  oracle: {
    ...EXPECTED,
    price: parsed.price,
    confidence: parsed.confidence,
    marketSession: parsed.marketSession,
    feedUpdateTimestampUs: feedTimestampUs.toString(),
    ageMs: Number(ageUs / 1_000n),
    payloadHash: update.payloadHash,
    payloadBytes: update.message.length,
    payload: "redacted",
  },
  instructions: instructions.map((instruction, index) => ({
    index,
    programId: instruction.programId.toBase58(),
    dataBytes: instruction.data.length,
    accounts: instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
  })),
  simulation: { err: simulation.err, unitsConsumed: simulation.unitsConsumed, lamportDeltas, logs: simulation.logs },
};
console.log(JSON.stringify(plan, null, 2));
if (simulation.err) process.exit(2);
if (!execute) process.exit(0);
const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
const finalizedSlot = await connection.getSlot("finalized");
console.log(JSON.stringify({ signature, finalizedSlot, status: "confirmed", payload: "redacted" }, null, 2));
