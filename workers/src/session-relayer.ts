import {
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ID, OPCODE, base64ToBytes } from "./transactions";
import type { Signer } from "./signer";
import type { SolanaL1Transport, MagicRouterTransport } from "./chain-transports";

/**
 * Session-key relayer (Priority 8, Section 15): the browser signs a
 * StockStream instruction with its client-held session key (never the main
 * wallet, and the session key never leaves the browser), builds the
 * transaction with the Worker's own keeper address as fee payer, and sends
 * the partially-signed wire transaction here. This module independently
 * re-validates the exact instruction family before ever adding the
 * Worker's own fee-payer signature and submitting -- the on-chain program
 * separately enforces the session's own nonce/action/notional/exposure
 * limits (`handlers.rs::authorize_trading_actor`), so this is defense in
 * depth, not the only check, but it is a real one: this relayer will never
 * co-sign and forward a transaction whose instruction isn't one of the
 * four the browser's session key is ever allowed to reach for.
 *
 * Deposit/withdrawal are structurally excluded already, on-chain: neither
 * `deposit_collateral` nor `withdraw_collateral` has a scoped-session
 * account in its account list at all (`handlers.rs`'s own comment: "a
 * session signer structurally cannot reach this path") -- the relayer
 * doesn't need to special-case them because there is no session-signed
 * form of them to relay in the first place.
 */

export const SESSION_ALLOWED_OPCODES: ReadonlySet<number> = new Set([
  OPCODE.placeOrder,
  OPCODE.cancelOrder,
  OPCODE.cancelAll,
  OPCODE.replaceOrder,
]);

export interface RelaySessionTransactionRequest {
  /** The client-built, session-key-signed (fee payer slot still empty) base64 wire transaction. */
  transactionBase64: string;
  expectedProgramAddress: string;
  sessionSignerAddress: string;
}

export type RelayValidation =
  | { ok: true; transaction: Transaction; opcode: number; seatIndex: number; actionNonce: bigint; placeOrderFlags: number }
  | { ok: false; reason: string };

/** Byte offset of `seat_index` (u16, LE) within each session-relayable
 * opcode's own instruction data -- mirrors `workers/src/transactions.ts`'s
 * builders exactly (`placeOrderData`/`cancelOrderInstruction`/
 * `cancelAllInstruction`/`replaceOrderInstruction`), never re-derived by
 * guesswork. `replaceOrder`'s data is `[opcode(1), oldOrderKey(16),
 * side(1), tree(1), flags(1), seatIndex(2), ...]`. */
const SEAT_INDEX_OFFSET: Readonly<Record<number, number>> = {
  [OPCODE.placeOrder]: 4,
  [OPCODE.cancelOrder]: 1,
  [OPCODE.cancelAll]: 1,
  [OPCODE.replaceOrder]: 20,
};

/** Byte offset of the order `flags` field, present only on the two opcodes
 * that can carry the reduce-only bit (`ORDER_FLAGS.reduceOnly = 4`). */
const FLAGS_OFFSET: Readonly<Record<number, number>> = {
  [OPCODE.placeOrder]: 3,
  [OPCODE.replaceOrder]: 19,
};

/** Every session-relayable opcode's instruction data ends with `actionNonce`
 * as its final 8 bytes (u64, LE) -- true of `placeOrderData`,
 * `cancelOrderInstruction`, `cancelAllInstruction`, and `replaceOrderInstruction`
 * (which reuses `placeOrderData`'s tail) alike. */
function extractActionNonce(data: Uint8Array): bigint | null {
  if (data.length < 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(data.length - 8, true);
}

/**
 * Decodes the incoming transaction and checks, independently of the
 * program: the fee-payer slot is exactly this relayer's own signer address
 * and still unsigned, the session signer's signature is a real,
 * cryptographically valid Ed25519 signature over this exact message (not
 * merely present), and the transaction carries exactly one non-compute-
 * budget instruction, targeting the caller-supplied canonical StockStream
 * program address with an opcode in `SESSION_ALLOWED_OPCODES`. On success,
 * also returns the opcode/seatIndex/actionNonce/flags extracted directly
 * from that instruction's own bytes -- never from caller-asserted fields --
 * so the authoritative on-chain chain check (`relay-auth.ts`) can verify
 * them against real session/seat state instead of trusting the request body.
 */
export async function validateSessionTransaction(request: RelaySessionTransactionRequest, relayerAddress: string): Promise<RelayValidation> {
  let transaction: Transaction;
  try {
    transaction = getTransactionDecoder().decode(base64ToBytes(request.transactionBase64)) as Transaction;
  } catch {
    return { ok: false, reason: "malformed transaction" };
  }

  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch {
    return { ok: false, reason: "malformed transaction message" };
  }

  const staticAccounts = compiled.staticAccounts;
  if (staticAccounts.length === 0 || staticAccounts[0] !== relayerAddress) {
    return { ok: false, reason: "fee payer must be this relayer's own address" };
  }
  const feePayerSignature = (transaction.signatures as Record<string, unknown>)[relayerAddress];
  if (feePayerSignature != null) {
    return { ok: false, reason: "fee-payer signature slot must still be empty" };
  }
  const sessionSignature = (transaction.signatures as Record<string, unknown>)[request.sessionSignerAddress] as Uint8Array | null;
  if (sessionSignature == null) {
    return { ok: false, reason: "session signer has not signed this transaction" };
  }
  const signatureIsValid = await verifyEd25519(request.sessionSignerAddress, sessionSignature, Uint8Array.from(transaction.messageBytes));
  if (!signatureIsValid) {
    return { ok: false, reason: "session signer's signature does not verify against this message" };
  }

  const tradingInstructions = compiled.instructions.filter((instruction) => staticAccounts[instruction.programAddressIndex] !== COMPUTE_BUDGET_PROGRAM_ID);
  if (tradingInstructions.length !== 1) {
    return { ok: false, reason: `expected exactly one trading instruction, found ${tradingInstructions.length}` };
  }
  const instruction = tradingInstructions[0];
  const programAddress = staticAccounts[instruction.programAddressIndex];
  if (programAddress !== request.expectedProgramAddress) {
    return { ok: false, reason: `instruction targets an unexpected program: ${programAddress}` };
  }
  const data = instruction.data as Uint8Array | undefined;
  if (!data || data.length === 0) {
    return { ok: false, reason: "instruction carries no data" };
  }
  const opcode = data[0];
  if (!SESSION_ALLOWED_OPCODES.has(opcode)) {
    return { ok: false, reason: `opcode ${opcode} is not allowed for a session-signed transaction` };
  }

  const seatIndexOffset = SEAT_INDEX_OFFSET[opcode];
  if (seatIndexOffset === undefined || seatIndexOffset + 2 > data.length) {
    return { ok: false, reason: "instruction data too short to contain a seat index" };
  }
  const seatIndex = data[seatIndexOffset] | (data[seatIndexOffset + 1] << 8);
  const actionNonce = extractActionNonce(data);
  if (actionNonce === null) {
    return { ok: false, reason: "instruction data too short to contain an action nonce" };
  }
  const flagsOffset = FLAGS_OFFSET[opcode];
  const placeOrderFlags = flagsOffset !== undefined && flagsOffset < data.length ? data[flagsOffset] : 0;

  return { ok: true, transaction, opcode, seatIndex, actionNonce, placeOrderFlags };
}

/** Real Ed25519 verification, not merely "a signature-shaped blob is
 * present" -- uses the same `crypto.subtle` Ed25519 support
 * `signer.ts` already relies on for signing (no new dependency, no
 * hand-rolled curve math). */
async function verifyEd25519(signerAddress: string, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const publicKeyBytes = getBase58Encoder().encode(signerAddress) as Uint8Array;
    const key = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch {
    return false;
  }
}

/**
 * Validates, then adds the relayer's own fee-payer signature over the
 * exact same message bytes the session key already signed, and returns the
 * fully-signed base64 wire transaction ready for submission. Never
 * modifies the message itself -- only fills the fee-payer's signature slot.
 */
export async function coSignSessionTransaction(request: RelaySessionTransactionRequest, signer: Signer): Promise<{ base64: string } | { error: string }> {
  const relayerAddress = getBase58Decoder().decode(await signer.publicKey());
  const validation = await validateSessionTransaction(request, relayerAddress);
  if (!validation.ok) return { error: validation.reason };

  const signatureBytes = await signer.sign(Uint8Array.from(validation.transaction.messageBytes));
  const signed: Transaction = {
    ...validation.transaction,
    signatures: { ...validation.transaction.signatures, [relayerAddress]: signatureBytes as SignatureBytes },
  };
  return { base64: getBase64EncodedWireTransaction(signed) };
}

/** Validates, co-signs, and submits through the given transport (L1 for a
 * regular session action, or the Magic Router transport for an ER-domain
 * one -- the caller picks the domain the same way every other keeper
 * submission already does). */
export async function relaySessionTransaction(
  request: RelaySessionTransactionRequest,
  signer: Signer,
  transport: SolanaL1Transport | MagicRouterTransport,
): Promise<{ signature: string } | { error: string }> {
  const result = await coSignSessionTransaction(request, signer);
  if ("error" in result) return result;
  const signature = await transport.sendTransaction(result.base64);
  return { signature };
}
