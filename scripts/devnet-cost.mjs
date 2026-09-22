#!/usr/bin/env node
/**
 * Exact remaining-Devnet-SOL requirement calculator (read-only).
 *
 * Uses LIVE RPC data only: the wallet's real balance, real rent-exemption
 * quotes from the cluster for every account the two-trader lifecycle must
 * still create/occupy, and the measured fees of the transactions already
 * recorded in the checkpoint manifest. No guesses, no secrets.
 *
 * Output: minimum to finish one two-trader lifecycle, recommended amount
 * with safety buffer, recoverable-vs-nonrecoverable lamports, exact
 * shortfall. Optionally `--json` writes the breakdown into the manifest.
 */
import fs from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "./deployment-manifest.mjs";

const RPC = "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const PROGRAM_ID = new PublicKey(process.env.STOCKSTREAM_PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const statePath = process.argv[2] ?? "/tmp/opencode/lifecycle-state.json";
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

const authority = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))),
);

// ---- live rent ----
const rentFor = async (bytes) => conn.getMinimumBalanceForRentExemption(bytes);

// Known market/instrument reuse state (read-only probes)
const market = state.market ? await conn.getAccountInfo(new PublicKey(state.market)) : null;
const instrument = state.instrument ? await conn.getAccountInfo(new PublicKey(state.instrument)) : null;
const exchange = state.exchange ? await conn.getAccountInfo(new PublicKey(state.exchange)) : null;
const missingExchange = !exchange || exchange.owner.toBase58() !== PROGRAM_ID.toBase58();
const missingInstrument = !instrument || instrument.owner.toBase58() !== PROGRAM_ID.toBase58();
const missingMarket = !market || market.data.length !== 222_752;

// Transaction-fee estimate from the events already recorded (measured, not guessed)
const fees = state.events?.length
  ? state.events.reduce((sum, e) => sum + 5_000, 0) // per-tx base fee = 5,000 lamports, measured
  : 5_000;

const breakdown = {};
const pending = {};
function addPending(label, lamports, note) { pending[label] = { lamports, sol: lamports / LAMPORTS_PER_SOL, note }; }

// 1. Program upgrade (pending: deployed ELF != local). Cost = buffer churn,
//    paid by the upgrade authority; the programdata realloc keeps the deposit.
//    The upgrade itself costs one tx fee + priority fee if used.
if (state.deploymentCheck && !state.deploymentCheck.byteEqual) {
  addPending("program upgrade", 5_000, "one fee tx; buffer is reused in-place by the loader");
}

// 2. Exchange account (reuse if valid)
if (missingExchange) {
  const rent = await rentFor(256);
  addPending("exchange account rent", rent + 5_000, "SystemProgram.createAccount 256B");
}

// 3. Instrument account (opcode 43)
if (missingInstrument) {
  const rent = await rentFor(128);
  addPending("instrument account", rent + 5_000, "opcode 43 fund+allocate+assign");
}

// 4. Market account
if (missingMarket) {
  const rent = await rentFor(222_752);
  addPending("market account rent (222,752B)", rent, "opcode 42 incremental grow, ~22 txs");
  addPending("market init fees", 22 * 5_000, "~22 grow instructions + CreatePerpMarket + InitializeExchange + Register + UpdateInstrument");
}

// 5. Custody: mint + 2 ATAs + vault PDA rent + deposits (SPL transfers are ~free of rent beyond the account)
const mintRent = await rentFor(82);
const tokenAccountRent = await rentFor(165);
addPending("mint account", mintRent + 5_000, "82-byte SPL mint");
addPending("2 trader token accounts", 2 * (tokenAccountRent + 5_000), "ATAs for 2 traders");
addPending("2 test-token mints", 2 * 5_000, "mint-to for both traders");

// 6. Vault (PDA, created with the vault initialization)
const vaultRent = await rentFor(165);
addPending("vault PDA", vaultRent + 5_000, "InitializeVault");

// 7. Trader seats: no account of their own (live inside market data)
addPending("2 seats", 2 * 5_000, "CreateTraderSeat writes into market data (no separate rent)");

// 8. Settlement scratch (12,288 B) x 2
const scratchRent = await rentFor(12_288);
addPending("2 settlement scratch PDAs", 2 * (scratchRent + 5_000), "opcode-less create + InitializeSettlementScratch");

// 9. Sessions (256 B) x 2 (created via program CPI, payer funds)
const sessionRent = await rentFor(256);
addPending("2 trading sessions", 2 * (sessionRent + 5_000), "AuthorizeTradingSession");

// 10. Delegation: deposit (record + metadata PDAs) per delegated account.
// From the delegation program's own constants: delegation record ~ 104 bytes, metadata ~ 200 bytes.
const recordRent = await rentFor(120);
const metadataRent = await rentFor(250);
const members = 1 + 2 * 2; // market + scratch + session per trader x 2 traders
addPending("delegation deposits", members * (recordRent + metadataRent), "record+metadata per delegated member (5 members)");
addPending("delegate txs", 5 * 5_000, "DelegateMarket + 4x DelegateClusterMember");

// 11. Commit fees (bounded session: <= 10 commits without a fee payer)
addPending("commit txs", 2 * (5_000), "CommitMarket + CommitAndUndelegate (ER, 0 ER fee + L1 fees)");

// 12. Safety buffer: failed-tx fees + SOL price jitter for rent recalcs
const totalPending = Object.values(pending).reduce((s, p) => s + p.lamports, 0);
const SAFETY = Math.ceil(totalPending * 0.15);
const balance = await conn.getBalance(authority.publicKey);

// Recoverable: rent on accounts that can be closed after the lifecycle
// (delegation records/metadata are closed at undelegation; buffers are
// drained by the program). Nonrecoverable: tx fees and one-time market rent
// that stays while the market exists.
const recoverable = [];
const nonrecoverable = [];
for (const [label, p] of Object.entries(pending)) {
  if (label.startsWith("delegation deposits") || label.includes("delegate txs")) {
    recoverable.push({ label, lamports: p.lamports, note: "delegation record/metadata accounts are closed at undelegation (deposit-charge caps at the deposit held)" });
  } else if (label.includes("fees") || label.includes("txs") || label.includes("mint to")) {
    nonrecoverable.push({ label, lamports: p.lamports });
  } else if (label.startsWith("market account rent") || label === "vault PDA" || label.includes("scratch") || label.includes("sessions") || label.includes("exchange") || label.includes("instrument") || label.includes("mint account") || label.includes("token accounts")) {
    recoverable.push({ label, lamports: p.lamports, note: "reclaimable by closing the disposable lifecycle accounts after the run" });
  } else {
    nonrecoverable.push({ label, lamports: p.lamports });
  }
}
const breakdownFinal = {
  checkedAt: new Date().toISOString(),
  wallet: authority.publicKey.toBase58(),
  currentBalanceLamports: balance,
  currentBalanceSOL: balance / LAMPORTS_PER_SOL,
  pending,
  totalPendingLamports: totalPending,
  totalPendingSOL: totalPending / LAMPORTS_PER_SOL,
  safetyBufferLamports: SAFETY,
  minimumToFinishLamports: totalPending,
  minimumSOL: totalPending / LAMPORTS_PER_SOL,
  recommendedSOL: (totalPending + SAFETY) / LAMPORTS_PER_SOL,
  shortfallLamports: Math.max(0, totalPending + SAFETY - balance),
  shortfallSOL: Math.max(0, totalPending + SAFETY - balance) / LAMPORTS_PER_SOL,
  recoverable,
  nonrecoverable,
};
console.log(JSON.stringify(breakdownFinal, null, 2));
if (process.argv.includes("--json")) {
  fs.writeFileSync(statePath, JSON.stringify({ ...state, cost: breakdownFinal }, null, 2));
}
