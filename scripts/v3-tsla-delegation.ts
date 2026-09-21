#!/usr/bin/env node
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { delegateV3Account } from "../clients/stockstream/src/abi/v3-instructions";
import {
  V3_BOOK_PAGE_SIZE,
  V3_EVENT_SHARD_SIZE,
  V3_MARKET_CORE_SIZE,
  V3_SEAT_SHARD_SIZE,
  decodeV3MarketCore,
} from "../clients/stockstream/src/abi/v3";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ROUTER = "https://devnet-router.magicblock.app";
const PROGRAM = new PublicKey("Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const INSTRUMENT = new PublicKey("9dJTKhEHupjB7bpyzCQm52ePKDq1o14XCP6MtLx6js77");
const CORE = new PublicKey("AN7JHGoaiQ4cbB4pxeigVjSEwLsTdtRBCJsFmcmG5XBs");
const VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const EXPECTED_ER = "https://devnet-as.magicblock.app/";
const CHECKPOINT = "/tmp/stockstream-tsla-v3-state-20260921.json";
const execute = process.argv.includes("--submit");
const targetArg = process.argv.find((value) => value.startsWith("--target="))?.slice(9) ?? "core";

type Entry = { label: string; kind: "core" | "book-page" | "seat-shard" | "event-shard"; index: number; parent: PublicKey; target: PublicKey; size: number };

function payer(): Keypair {
  const path = process.env.SOLANA_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function checkpointEntries(): Entry[] {
  const state = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
  if (state.version !== 3 || state.core !== CORE.toBase58() || state.instrument !== INSTRUMENT.toBase58()) throw new Error("TSLA checkpoint identity mismatch");
  if (state.exchange !== "AW5ByA33xvoewXNfRRSQ4Am9z5fYs3i9mpjdUdtbEREK") throw new Error("TSLA exchange mismatch");
  if (state.v3Accounts?.bookPages?.length !== 18 || state.v3Accounts?.seatShards?.length !== 4 || state.v3Accounts?.eventShards?.length !== 4) throw new Error("incomplete TSLA execution bundle");
  return [
    { label: "core", kind: "core", index: 0, parent: INSTRUMENT, target: CORE, size: V3_MARKET_CORE_SIZE },
    ...state.v3Accounts.bookPages.map((address: string, index: number) => ({ label: `book-${Math.floor(index / 9)}-${index % 9}`, kind: "book-page" as const, index, parent: CORE, target: new PublicKey(address), size: V3_BOOK_PAGE_SIZE })),
    ...state.v3Accounts.seatShards.map((address: string, index: number) => ({ label: `seat-${index}`, kind: "seat-shard" as const, index, parent: CORE, target: new PublicKey(address), size: V3_SEAT_SHARD_SIZE })),
    ...state.v3Accounts.eventShards.map((address: string, index: number) => ({ label: `event-${index}`, kind: "event-shard" as const, index, parent: CORE, target: new PublicKey(address), size: V3_EVENT_SHARD_SIZE })),
  ];
}

async function routerStatus(address: PublicKey) {
  const response = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [address.toBase58()] }) });
  const body = await response.json() as { result?: { isDelegated?: boolean; fqdn?: string; delegationRecord?: { authority?: string } }; error?: unknown };
  if (!response.ok || body.error || !body.result) throw new Error(`Magic Router status failed: ${JSON.stringify(body.error ?? response.status)}`);
  return body.result;
}

const entries = checkpointEntries();
if (new Set(entries.map(({ target }) => target.toBase58())).size !== 27) throw new Error("duplicate TSLA execution account alias");
const selected = entries.find(({ label }) => label === targetArg);
if (!selected) throw new Error(`unknown --target; expected one of: ${entries.map(({ label }) => label).join(", ")}`);
const selectedPosition = entries.indexOf(selected);
const signer = payer();
if (signer.publicKey.toBase58() !== "A5sV4PkkVM4gm3rejACvKFgxEMmj8ouGsffSKT5qYVc8") throw new Error("unexpected authority/fee payer");
const connection = new Connection(RPC, "confirmed");
const infos = await connection.getMultipleAccountsInfo(entries.map(({ target }) => target), "confirmed");
for (let index = 0; index < entries.length; index += 1) {
  const entry = entries[index]; const info = infos[index];
  const expectedOwner = index < selectedPosition ? DELEGATION_PROGRAM : PROGRAM;
  if (!info || !info.owner.equals(expectedOwner) || info.data.length !== entry.size) throw new Error(`${entry.label}: missing, wrong-sized, or not in the required canonical delegation state`);
}
const coreView = decodeV3MarketCore(infos[0]!.data);
if (!coreView.instrument.equals(INSTRUMENT) || !coreView.marketAuthority.equals(signer.publicKey) || coreView.mode !== 1) throw new Error("TSLA core authority/instrument/mode mismatch");
const statuses = await Promise.all(entries.map(({ target }) => routerStatus(target)));
for (let index = 0; index < statuses.length; index += 1) {
  const status = statuses[index];
  if (index < selectedPosition) {
    if (!status.isDelegated || status.fqdn !== EXPECTED_ER || status.delegationRecord?.authority !== VALIDATOR.toBase58()) throw new Error(`${entries[index].label}: prior delegation is missing or routed to the wrong ER validator`);
  } else if (status.isDelegated) throw new Error(`${entries[index].label}: selected or later account is unexpectedly delegated`);
}

const instruction = delegateV3Account({ parent: selected.parent, target: selected.target, authority: signer.publicKey, payer: signer.publicKey }, selected.kind, VALIDATOR, selected.index);
if (!instruction.programId.equals(PROGRAM) || instruction.data[0] !== 48) throw new Error("canonical delegation builder mismatch");
const transaction = new Transaction().add(instruction);
const latestBlockhash = await connection.getLatestBlockhash("confirmed");
transaction.feePayer = signer.publicKey;
transaction.recentBlockhash = latestBlockhash.blockhash;
transaction.sign(signer);
const watched = [signer.publicKey, ...instruction.keys.filter(({ pubkey, isWritable }) => isWritable && !pubkey.equals(signer.publicKey)).map(({ pubkey }) => pubkey)];
const before = await connection.getMultipleAccountsInfo(watched, "confirmed");
const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [transaction.serialize().toString("base64"), { encoding: "base64", commitment: "confirmed", sigVerify: true, accounts: { encoding: "base64", addresses: watched.map((address) => address.toBase58()) } }] }) });
const body = await response.json() as { result?: { value?: { err: unknown; unitsConsumed?: number; logs?: string[]; accounts?: Array<{ lamports: number; owner: string; data: [string, string] } | null> } }; error?: unknown };
if (!response.ok || body.error || !body.result?.value) throw new Error(`simulation RPC failed: ${JSON.stringify(body.error ?? response.status)}`);
const simulation = body.result.value;
const after = simulation.accounts ?? [];
const plan = {
  submitted: false,
  scope: "isolated TSLA V3 core delegation only",
  bundleAudit: { accountCount: entries.length, allExist: true, canonicalPrefixDelegated: selectedPosition, remainingFreshProgramOwned: entries.length - selectedPosition, noDuplicates: true, unexpectedlyDelegated: 0 },
  executionDomain: { kind: "MagicBlock ER", validator: VALIDATOR.toBase58(), expectedEndpoint: EXPECTED_ER, perIntegrationPresent: false },
  transaction: {
    instruction: "DelegateV3Account", opcode: 48, kind: selected.kind, index: selected.index,
    programId: instruction.programId.toBase58(), feePayer: signer.publicKey.toBase58(), signers: [signer.publicKey.toBase58()],
    accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }, index) => ({ index, address: pubkey.toBase58(), signer: isSigner, writable: isWritable })),
    expectedLamportDeltas: watched.map((address, index) => ({ address: address.toBase58(), before: before[index]?.lamports ?? 0, after: after[index]?.lamports ?? 0, delta: (after[index]?.lamports ?? 0) - (before[index]?.lamports ?? 0) })),
    expectedUsdcDelta: 0,
  },
  simulation: { error: simulation.err, unitsConsumed: simulation.unitsConsumed, logs: simulation.logs },
};
console.log(JSON.stringify(plan, null, 2));
if (simulation.err) process.exit(2);
if (!execute) process.exit(0);
if (process.env.CONFIRM_TSLA_DELEGATION_TARGET !== selected.target.toBase58()) throw new Error("set CONFIRM_TSLA_DELEGATION_TARGET to the exact target address after approval");
const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
console.log(JSON.stringify({ submitted: true, signature, slot: status.context.slot, confirmationStatus: status.value?.confirmationStatus, error: status.value?.err }, null, 2));
