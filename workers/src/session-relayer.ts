import {
  getBase58Decoder,
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
  | { ok: true; transaction: Transaction }
  | { ok: false; reason: string };

/**
 * Decodes the incoming transaction and checks, independently of the
 * program: the fee-payer slot is exactly this relayer's own signer address
 * and still unsigned, the session signer already produced a real
 * signature, and every non-compute-budget instruction targets the
 * StockStream program with an opcode in `SESSION_ALLOWED_OPCODES`.
 */
export function validateSessionTransaction(request: RelaySessionTransactionRequest, relayerAddress: string): RelayValidation {
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
  const sessionSignature = (transaction.signatures as Record<string, unknown>)[request.sessionSignerAddress];
  if (sessionSignature == null) {
    return { ok: false, reason: "session signer has not signed this transaction" };
  }

  for (const instruction of compiled.instructions) {
    const programAddress = staticAccounts[instruction.programAddressIndex];
    if (programAddress === COMPUTE_BUDGET_PROGRAM_ID) continue;
    if (programAddress !== request.expectedProgramAddress) {
      return { ok: false, reason: `instruction targets an unexpected program: ${programAddress}` };
    }
    const opcode = instruction.data?.[0];
    if (opcode === undefined || !SESSION_ALLOWED_OPCODES.has(opcode)) {
      return { ok: false, reason: `opcode ${opcode ?? "<none>"} is not allowed for a session-signed transaction` };
    }
  }

  return { ok: true, transaction };
}

/**
 * Validates, then adds the relayer's own fee-payer signature over the
 * exact same message bytes the session key already signed, and returns the
 * fully-signed base64 wire transaction ready for submission. Never
 * modifies the message itself -- only fills the fee-payer's signature slot.
 */
export async function coSignSessionTransaction(request: RelaySessionTransactionRequest, signer: Signer): Promise<{ base64: string } | { error: string }> {
  const relayerAddress = getBase58Decoder().decode(await signer.publicKey());
  const validation = validateSessionTransaction(request, relayerAddress);
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
