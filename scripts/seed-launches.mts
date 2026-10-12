// Seeds the Launch page with showcase launches, one per Pulse column: a fresh
// creator wallet (0.3 SOL from the CLI wallet, test USDC from the faucet)
// creates each on the quick-graduate preset, buys it to its target stage,
// graduates the one meant for "Graduated", and registers all with the API.
// Run: npx tsx scripts/seed-launches.mts
import fs from "node:fs";
import os from "node:os";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, type Transaction as Tx } from "@solana/web3.js";
import nacl from "tweetnacl";
import { buildGraduateTransaction, buildLaunchTransaction, buildSwapTransaction, LAUNCH_PRESETS, readPool } from "../features/launch/dbc-launch";

const SITE = "https://equinox.ansht.workers.dev";
const API = "https://stockstream-market-api.ansht.workers.dev";
const LAUNCHES = [
  { symbol: "GIGA", name: "Gigafactory", image: "giga.svg", buyUsd: 600, graduate: true },   // Graduated
  { symbol: "TENSOR", name: "Tensor Cores", image: "tensor.svg", buyUsd: 330, graduate: false }, // Final stretch (~70%)
  { symbol: "ORCHARD", name: "Orchard", image: "orchard.svg", buyUsd: 55, graduate: false },    // New pairs
];
const registered = await fetch(`${API}/v1/launches`).then(async (response) => {
  if (!response.ok) throw new Error(`launch registry unavailable: ${response.status}`);
  return response.json() as Promise<{ launches: { symbol: string }[] }>;
});
const missing = LAUNCHES.filter((launch) => !registered.launches.some((row) => row.symbol === launch.symbol));
if (missing.length === 0) {
  console.log("Showcase launches already registered; nothing to seed.");
  process.exit(0);
}

const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
const creator = Keypair.generate();
const preset = LAUNCH_PRESETS.find((p) => p.id === "devnet")!;
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function send(transaction: Tx, lastValidBlockHeight: number) {
  transaction.partialSign(creator);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  const outcome = await connection.confirmTransaction({ signature, blockhash: transaction.recentBlockhash!, lastValidBlockHeight }, "confirmed");
  if (outcome.value.err) throw new Error(`${signature} failed: ${JSON.stringify(outcome.value.err)}`);
  return signature;
}

log("creator", creator.publicKey.toBase58());
await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creator.publicKey, lamports: 300_000_000 })), [funder]);
const message = `Equinox devnet faucet\nwallet: ${creator.publicKey.toBase58()}\nissued: ${Math.floor(Date.now() / 1000)}`;
const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), creator.secretKey)).toString("base64");
const faucet = await fetch(`${API}/v1/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: creator.publicKey.toBase58(), message, signature }) });
log("faucet", faucet.status, await faucet.text());
await new Promise((r) => setTimeout(r, 8_000));

for (const launch of missing) {
  const built = await buildLaunchTransaction(connection, { name: launch.name, symbol: launch.symbol, uri: `${SITE}/launches/${launch.image}`, preset, creator: creator.publicKey });
  log(launch.symbol, "created", await send(built.transaction, built.lastValidBlockHeight));
  const registered = await fetch(`${API}/v1/launches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: built.pool.toBase58(), baseMint: built.baseMint.toBase58(), symbol: launch.symbol, name: launch.name, preset: preset.id }) });
  log(launch.symbol, "registered", registered.status);
  // Several buyers' worth of trades rather than one block.
  const chunks = launch.graduate ? [120, 150, 110, 220] : [launch.buyUsd * 0.4, launch.buyUsd * 0.35, launch.buyUsd * 0.25];
  for (const amount of chunks) {
    const swap = await buildSwapTransaction(connection, { owner: creator.publicKey, pool: built.pool, side: "buy", amount, slippageBps: 500 });
    await send(swap.transaction, swap.lastValidBlockHeight);
  }
  let view = await readPool(connection, built.pool);
  log(launch.symbol, `progress ${(view.progress * 100).toFixed(0)}%`, `raised $${view.raisedUsd.toFixed(2)}/${view.thresholdUsd.toFixed(2)}`);
  if (launch.graduate) {
    const graduate = await buildGraduateTransaction(connection, { payer: creator.publicKey, pool: built.pool });
    log(launch.symbol, "graduated", await send(graduate.transaction, graduate.lastValidBlockHeight));
    view = await readPool(connection, built.pool);
    log(launch.symbol, "DAMM v2 pool", view.dammPool);
  }
}
log("done; creator", creator.publicKey.toBase58(), "SOL left", (await connection.getBalance(creator.publicKey)) / 1e9);
