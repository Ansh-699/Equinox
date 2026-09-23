/**
 * On-demand refresh of the L1 OracleSnapshotV3 for browser writes. The
 * program accepts any payer for a newer Pyth-signed price (the signature is
 * the authentication), so the Worker's keeper key only pays fees and never
 * holds market authority. A snapshot younger than FRESH_SECONDS is reused,
 * which caps spend at one transaction per window however many users call.
 */
import { AccountRole, address, getBase58Decoder, type Instruction } from "@solana/kit";
import { decodeOracleSnapshot, type OracleSnapshotView } from "./oracle-snapshot";
import { signAndSerializeTransaction } from "./transactions";
import type { Signer } from "./signer";

export const FRESH_SECONDS = 3;
const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
const PYTH_PROGRAM = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
const PYTH_STORAGE = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
const UPDATE_ORACLE_SNAPSHOT_V3 = 58;
/** Where the signed message starts inside the snapshot instruction's data. */
const MESSAGE_OFFSET = 4;

export interface RefreshMarket { programId: string; core: string; snapshot: string; feedId: number; channel: string }

export interface RefreshDeps {
  now(): number;
  readAccount(address: string): Promise<Uint8Array | null>;
  fetchSignedMessage(feedId: number, channel: string): Promise<Uint8Array>;
  signer: Signer;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  send(transactionBase64: string): Promise<string>;
  confirm(signature: string, lastValidBlockHeight: bigint): Promise<"confirmed" | "failed" | "expired" | "timeout">;
}

export type RefreshResult =
  | { status: "fresh" | "refreshed"; sequence: string; publishTime: number; signature?: string }
  | { status: "failed"; reason: string; payer?: string };

/** Ed25519 verify instruction for a Pyth Lazer Solana-format message that the
 * instruction at `consumerIndex` carries at MESSAGE_OFFSET. */
export function ed25519Instruction(message: Uint8Array, consumerIndex: number): Instruction {
  if (message.length < 102) throw new Error("invalid signed Pyth message");
  const size = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint16(100, true);
  if (message.length !== 102 + size) throw new Error("invalid signed Pyth message framing");
  const signatureOffset = MESSAGE_OFFSET + 4;
  const publicKeyOffset = signatureOffset + 64;
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  data[0] = 1;
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, consumerIndex, true);
  view.setUint16(6, publicKeyOffset, true);
  view.setUint16(8, consumerIndex, true);
  view.setUint16(10, publicKeyOffset + 32 + 2, true);
  view.setUint16(12, size, true);
  view.setUint16(14, consumerIndex, true);
  return { programAddress: address(ED25519_PROGRAM), accounts: [], data };
}

export function snapshotUpdateInstruction(market: RefreshMarket, payer: string, treasury: string, message: Uint8Array, ed25519Index: number): Instruction {
  const data = new Uint8Array(MESSAGE_OFFSET + message.length);
  data[0] = UPDATE_ORACLE_SNAPSHOT_V3;
  new DataView(data.buffer).setUint16(1, ed25519Index, true);
  data[3] = 0;
  data.set(message, MESSAGE_OFFSET);
  const role = (value: string, accountRole: AccountRole) => ({ address: address(value), role: accountRole });
  return {
    programAddress: address(market.programId),
    accounts: [
      role(market.snapshot, AccountRole.WRITABLE), role(market.core, AccountRole.READONLY),
      role(payer, AccountRole.WRITABLE_SIGNER), role(PYTH_PROGRAM, AccountRole.READONLY),
      role(PYTH_STORAGE, AccountRole.READONLY), role(treasury, AccountRole.WRITABLE),
      role(SYSTEM_PROGRAM, AccountRole.READONLY), role(INSTRUCTIONS_SYSVAR, AccountRole.READONLY),
    ],
    data,
  };
}

async function currentSnapshot(deps: RefreshDeps, market: RefreshMarket): Promise<OracleSnapshotView | null> {
  const bytes = await deps.readAccount(market.snapshot);
  return bytes ? decodeOracleSnapshot(bytes) : null;
}

const summary = (status: "fresh" | "refreshed", snapshot: OracleSnapshotView, signature?: string): RefreshResult =>
  ({ status, sequence: snapshot.sequence.toString(), publishTime: Number(snapshot.publishTimestamp), ...(signature ? { signature } : {}) });

export async function refreshOracleSnapshot(market: RefreshMarket, deps: RefreshDeps): Promise<RefreshResult> {
  const isFresh = (snapshot: OracleSnapshotView | null): snapshot is OracleSnapshotView =>
    !!snapshot && Math.floor(deps.now() / 1000) - Number(snapshot.publishTimestamp) < FRESH_SECONDS;
  const before = await currentSnapshot(deps, market);
  if (isFresh(before)) return summary("fresh", before);

  const storage = await deps.readAccount(PYTH_STORAGE);
  if (!storage || storage.length < 72) return { status: "failed", reason: "Pyth storage account unavailable" };
  const treasury = getBase58Decoder().decode(storage.slice(40, 72));
  const payer = getBase58Decoder().decode(await deps.signer.publicKey());
  const message = await deps.fetchSignedMessage(market.feedId, market.channel);
  const { blockhash, lastValidBlockHeight } = await deps.latestBlockhash();
  const transaction = await signAndSerializeTransaction({
    // No compute-budget prefix: the Ed25519 instruction must stay at index 0.
    instructions: [ed25519Instruction(message, 1), snapshotUpdateInstruction(market, payer, treasury, message, 0)],
    signer: deps.signer, recentBlockhash: blockhash, lastValidBlockHeight, computeUnitLimit: null,
  });
  let signature: string;
  try {
    signature = await deps.send(transaction);
  } catch (error) {
    // A concurrent refresh may have landed a same-or-newer price first.
    const after = await currentSnapshot(deps, market);
    if (isFresh(after)) return summary("fresh", after);
    return { status: "failed", reason: error instanceof Error ? error.message : String(error), payer };
  }
  const outcome = await deps.confirm(signature, lastValidBlockHeight);
  const after = await currentSnapshot(deps, market);
  if (outcome === "confirmed" && after) return summary("refreshed", after, signature);
  if (isFresh(after)) return summary("fresh", after);
  return { status: "failed", reason: `snapshot update ${outcome}`, payer };
}

const PYTH_HTTP_ENDPOINTS = [0, 1, 2].map((index) => `https://pyth-lazer-${index}.dourolabs.app/v1/latest_price`);

/** Fetches the newest Solana-format signed update, trying each Pyth endpoint. */
export async function fetchPythSolanaMessage(apiKey: string, feedId: number, channel: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let lastError = "no Pyth endpoint responded";
  for (const endpoint of PYTH_HTTP_ENDPOINTS) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ priceFeedIds: [feedId], properties: ["price", "exponent", "confidence", "marketSession", "feedUpdateTimestamp"], formats: ["solana"], jsonBinaryEncoding: "base64", parsed: true, channel }),
      });
      if (!response.ok) { lastError = `Pyth ${response.status}`; continue; }
      const body = await response.json() as { solana?: { data?: string } };
      if (!body.solana?.data) { lastError = "Pyth response missing Solana payload"; continue; }
      return Uint8Array.from(atob(body.solana.data), (character) => character.charCodeAt(0));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}
