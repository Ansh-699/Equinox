/**
 * Real Solana transaction construction for the Worker, on `@solana/kit` 5.5.1.
 *
 * `keeper-jobs.ts` deliberately treats wire-format construction as an injected
 * boundary (`TransactionBuilder<TInput>`). This module is the concrete
 * implementation of that boundary: it encodes StockStream instructions (the
 * exact data layouts and account orders mirrored by
 * `clients/stockstream/src/index.ts`), assembles a v0 transaction message,
 * signs it with the Worker's WebCrypto `Signer`, and returns the base64 wire
 * transaction the L1/ER transports already accept.
 *
 * Signing: the Worker `Signer` (signer.ts) exposes only `publicKey()`/`sign(bytes)`.
 * `@solana/kit` compiles the message and hands over the exact bytes to sign; the
 * 64-byte Ed25519 signature the Worker signer returns is placed into the
 * transaction's signature dictionary -- no key material crosses the boundary.
 *
 * Scope: the encoders below cover every instruction family the keepers and
 * clients use. Where the full account list is context-dependent (an ER
 * validator, the Pyth storage/treasury accounts, a scoped session account),
 * the caller supplies the `AccountMeta`s explicitly rather than this
 * module guessing them. `consumeOracleUpdateInstruction` takes the wrapping
 * Ed25519 instruction index and signature index because the single
 * transaction must include that pre-instruction (the caller builds it from
 * the Pyth Lazer message; see the program's `consume_oracle_update`, which
 * reads both fields out of the instruction data).
 */

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Instruction,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import type {
  CleanupKeeperInput,
  CommitKeeperInput,
  FundingKeeperInput,
  LiquidationKeeperInput,
  PythKeeperInput,
  SessionKeeperInput,
  TransactionBuilder,
} from "./keeper-jobs";
import type { Signer } from "./signer";

// ---------------------------------------------------------------------
// Wire primitives
// ---------------------------------------------------------------------

const READONLY = AccountRole.READONLY;
const WRITABLE = AccountRole.WRITABLE;
const READONLY_SIGNER = AccountRole.READONLY_SIGNER;

export type AccountSpec = Readonly<{ address: string; role: AccountRole }>;

export function meta(addressString: string, role: AccountRole = READONLY): AccountMeta {
  return { address: address(addressString), role };
}

/** Little-endian fixed-width writer, matching the program's `read_u*` decoders. */
class DataWriter {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`u8 out of range: ${value}`);
    this.bytes.push(value);
    return this;
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  private unsigned(value: bigint, bytes: number): this {
    const mask = (1n << BigInt(bytes * 8)) - 1n;
    if (value < 0n || value > mask) throw new RangeError(`unsigned ${bytes * 8}-bit out of range: ${value}`);
    let remaining = value;
    for (let i = 0; i < bytes; i += 1) {
      this.bytes.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    return this;
  }

  private signed(value: bigint, bytes: number): this {
    const min = -(1n << BigInt(bytes * 8 - 1));
    const max = (1n << BigInt(bytes * 8 - 1)) - 1n;
    if (value < min || value > max) throw new RangeError(`signed ${bytes * 8}-bit out of range: ${value}`);
    let remaining = value < 0n ? (1n << BigInt(bytes * 8)) + value : value;
    for (let i = 0; i < bytes; i += 1) {
      this.bytes.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    return this;
  }

  u64(value: bigint): this {
    return this.unsigned(value, 8);
  }

  i64(value: bigint): this {
    return this.signed(value, 8);
  }

  i128(value: bigint): this {
    return this.signed(value, 16);
  }

  u128(value: bigint): this {
    return this.unsigned(value, 16);
  }

  raw(value: Uint8Array): this {
    for (const byte of value) this.bytes.push(byte);
    return this;
  }

  pubkey(value: Uint8Array): this {
    if (value.length !== 32) throw new RangeError(`pubkey must be 32 bytes, got ${value.length}`);
    return this.raw(value);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function instruction(programAddress: string, accounts: AccountMeta[], data: Uint8Array): Instruction {
  return { programAddress: address(programAddress), accounts, data };
}

// ---------------------------------------------------------------------
// StockStream instruction encoders
//
// Opcodes per programs/stockstream/src/instruction.rs. Account orders per the
// Rust handlers and clients/stockstream/src/index.ts.
// ---------------------------------------------------------------------

export const OPCODE = {
  placeOrder: 3,
  cancelOrder: 4,
  cancelAll: 5,
  updateFunding: 6,
  liquidate: 7,
  initializeVault: 9,
  depositCollateral: 10,
  withdrawCollateral: 11,
  consumeOracleUpdate: 12,
  delegateMarket: 13,
  commitMarket: 14,
  commitAndUndelegate: 15,
  authorizeTradingSession: 17,
  revokeTradingSession: 18,
  pauseMarket: 25,
  resumeMarket: 26,
  setCloseOnly: 27,
  updateTradingSessionLimits: 31,
  closeTradingSession: 32,
  replaceOrder: 33,
  transferToInsuranceFund: 34,
  withdrawProtocolFees: 35,
  withdrawInsuranceFunds: 36,
  recordBadDebt: 37,
  resolveBadDebt: 38,
  reconcileVault: 39,
} as const;

/** Deposit/withdraw reduce-only flag bits (`place_order`'s `flags` byte). */
export const ORDER_FLAGS = { postOnly: 1, immediateOrCancel: 2, reduceOnly: 4 } as const;

export interface PlaceOrderFields {
  side: "bid" | "ask";
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  reduceOnly?: boolean;
  tree?: "fixed" | "pegged";
  seatIndex: number;
  quantity: bigint;
  priceOrOffset: bigint;
  expiresAt?: bigint;
  pegLimit?: bigint;
  clientOrderId: bigint;
  actionNonce?: bigint;
}

function placeOrderData(fields: PlaceOrderFields): DataWriter {
  const side = fields.side === "bid" ? 0 : 1;
  const tree = (fields.tree ?? "fixed") === "fixed" ? 0 : 1;
  const flags =
    (fields.postOnly ? ORDER_FLAGS.postOnly : 0) |
    (fields.immediateOrCancel ? ORDER_FLAGS.immediateOrCancel : 0) |
    (fields.reduceOnly ? ORDER_FLAGS.reduceOnly : 0);
  return new DataWriter()
    .u8(OPCODE.placeOrder)
    .u8(side)
    .u8(tree)
    .u8(flags)
    .u16(fields.seatIndex)
    .u64(fields.quantity)
    .i64(fields.priceOrOffset)
    .u64(fields.expiresAt ?? 0n)
    .i64(fields.pegLimit ?? 0n)
    .u64(fields.clientOrderId)
    .u64(fields.actionNonce ?? 0n);
}

export function placeOrderInstruction(programAddress: string, accounts: AccountMeta[], fields: PlaceOrderFields): Instruction {
  return instruction(programAddress, accounts, placeOrderData(fields).build());
}

export function cancelOrderInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number, orderKey: bigint, actionNonce = 0n): Instruction {
  const data = new DataWriter().u8(OPCODE.cancelOrder).u16(seatIndex).u128(orderKey).u64(actionNonce).build();
  return instruction(programAddress, accounts, data);
}

export function cancelAllInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number, maxCancellations: number, actionNonce = 0n): Instruction {
  const data = new DataWriter().u8(OPCODE.cancelAll).u16(seatIndex).u8(maxCancellations).u64(actionNonce).build();
  return instruction(programAddress, accounts, data);
}

export function replaceOrderInstruction(programAddress: string, accounts: AccountMeta[], oldOrderKey: bigint, fields: PlaceOrderFields): Instruction {
  const place = placeOrderData(fields).build();
  const data = new DataWriter().u8(OPCODE.replaceOrder).u128(oldOrderKey).raw(place.subarray(1)).build();
  return instruction(programAddress, accounts, data);
}

export function updateFundingInstruction(programAddress: string, accounts: AccountMeta[], accumulator: bigint, timestamp: bigint): Instruction {
  const data = new DataWriter().u8(OPCODE.updateFunding).i128(accumulator).u64(timestamp).build();
  return instruction(programAddress, accounts, data);
}

export function liquidateInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number, maxQuantity: bigint): Instruction {
  const data = new DataWriter().u8(OPCODE.liquidate).u16(seatIndex).u64(maxQuantity).build();
  return instruction(programAddress, accounts, data);
}

export function initializeVaultInstruction(programAddress: string, accounts: AccountMeta[]): Instruction {
  return instruction(programAddress, accounts, Uint8Array.of(OPCODE.initializeVault));
}

export function depositCollateralInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number, amount: bigint): Instruction {
  const data = new DataWriter().u8(OPCODE.depositCollateral).u16(seatIndex).u64(amount).build();
  return instruction(programAddress, accounts, data);
}

export function withdrawCollateralInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number, amount: bigint): Instruction {
  const data = new DataWriter().u8(OPCODE.withdrawCollateral).u16(seatIndex).u64(amount).build();
  return instruction(programAddress, accounts, data);
}

/** `undefined` index means "no scoped session account": the account list is the keeper's to supply. */
export function delegateMarketInstruction(programAddress: string, accounts: AccountMeta[], validator: Uint8Array): Instruction {
  if (validator.length !== 32) throw new RangeError("validator must be 32 bytes");
  const data = new DataWriter().u8(OPCODE.delegateMarket).pubkey(validator).build();
  return instruction(programAddress, accounts, data);
}

export function commitMarketInstruction(programAddress: string, accounts: AccountMeta[], sequence: bigint, undelegate: boolean): Instruction {
  const opcode = undelegate ? OPCODE.commitAndUndelegate : OPCODE.commitMarket;
  const data = new DataWriter().u8(opcode).u64(sequence).build();
  return instruction(programAddress, accounts, data);
}

export function authorizeTradingSessionInstruction(
  programAddress: string,
  accounts: AccountMeta[],
  fields: { seatIndex: number; expiresAt: bigint; actions: number; maxOrderNotional: bigint; maxCumulativeNotional: bigint; maximumExposure: bigint; maximumOpenOrders: number },
): Instruction {
  const data = new DataWriter()
    .u8(OPCODE.authorizeTradingSession)
    .u16(fields.seatIndex)
    .u64(fields.expiresAt)
    .u8(fields.actions)
    .u64(fields.maxOrderNotional)
    .u64(fields.maxCumulativeNotional)
    .i128(fields.maximumExposure)
    .u16(fields.maximumOpenOrders)
    .build();
  return instruction(programAddress, accounts, data);
}

export function updateTradingSessionLimitsInstruction(
  programAddress: string,
  accounts: AccountMeta[],
  fields: { seatIndex: number; expiresAt: bigint; actions: number; maxOrderNotional: bigint; maxCumulativeNotional: bigint; maximumExposure: bigint; maximumOpenOrders: number },
): Instruction {
  const data = new DataWriter()
    .u8(OPCODE.updateTradingSessionLimits)
    .u16(fields.seatIndex)
    .u64(fields.expiresAt)
    .u8(fields.actions)
    .u64(fields.maxOrderNotional)
    .u64(fields.maxCumulativeNotional)
    .i128(fields.maximumExposure)
    .u16(fields.maximumOpenOrders)
    .build();
  return instruction(programAddress, accounts, data);
}

export function revokeTradingSessionInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.revokeTradingSession).u16(seatIndex).build());
}

export function closeTradingSessionInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.closeTradingSession).u16(seatIndex).build());
}

export type MarketTransition = "pause" | "resume" | "close-only";

export function transitionMarketInstruction(programAddress: string, accounts: AccountMeta[], mode: MarketTransition): Instruction {
  const opcode = mode === "pause" ? OPCODE.pauseMarket : mode === "resume" ? OPCODE.resumeMarket : OPCODE.setCloseOnly;
  return instruction(programAddress, accounts, Uint8Array.of(opcode));
}

export function transferToInsuranceFundInstruction(programAddress: string, accounts: AccountMeta[], amount: bigint): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.transferToInsuranceFund).u64(amount).build());
}

export function withdrawProtocolFeesInstruction(programAddress: string, accounts: AccountMeta[], amount: bigint): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.withdrawProtocolFees).u64(amount).build());
}

export function withdrawInsuranceFundsInstruction(programAddress: string, accounts: AccountMeta[], amount: bigint): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.withdrawInsuranceFunds).u64(amount).build());
}

export function recordBadDebtInstruction(programAddress: string, accounts: AccountMeta[], seatIndex: number, amount: bigint): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.recordBadDebt).u16(seatIndex).u64(amount).build());
}

export function resolveBadDebtInstruction(programAddress: string, accounts: AccountMeta[], amount: bigint): Instruction {
  return instruction(programAddress, accounts, new DataWriter().u8(OPCODE.resolveBadDebt).u64(amount).build());
}

export function reconcileVaultInstruction(programAddress: string, accounts: AccountMeta[]): Instruction {
  return instruction(programAddress, accounts, Uint8Array.of(OPCODE.reconcileVault));
}

/**
 * `ConsumeOracleUpdate`: data is `[12, ed25519_instruction_index:u16,
 * signature_index:u8, ...pyth_message]`. The single transaction must also
 * carry the Ed25519 native-program instruction those indices point at; the
 * caller builds it from the Pyth Lazer message.
 */
export function consumeOracleUpdateInstruction(programAddress: string, accounts: AccountMeta[], ed25519InstructionIndex: number, signatureIndex: number, message: Uint8Array): Instruction {
  if (message.length === 0 || message.length > 512) throw new RangeError(`pyth message must be 1..=512 bytes, got ${message.length}`);
  const data = new DataWriter().u8(OPCODE.consumeOracleUpdate).u16(ed25519InstructionIndex).u8(signatureIndex).raw(message).build();
  return instruction(programAddress, accounts, data);
}

// ---------------------------------------------------------------------
// Signing + serialization
// ---------------------------------------------------------------------

export interface SignedTransactionRequest {
  instructions: readonly Instruction[];
  signer: Signer;
  recentBlockhash: string;
  /**
   * Only used by RPC clients to decide when to stop retrying a send; never
   * serialized into the transaction's message bytes (only `recentBlockhash`
   * is). The keeper boundary (`TransactionBuilder.build`) doesn't supply
   * one, so it defaults to the library's own "never expires" sentinel.
   */
  lastValidBlockHeight?: bigint;
}

/**
 * Builds, signs and base64-encodes one v0 transaction. The Worker signer signs
 * the compiled message bytes directly; its Ed25519 signature is placed into the
 * transaction's signature dictionary keyed by the signer's own address.
 */
export async function signAndSerializeTransaction(request: SignedTransactionRequest): Promise<string> {
  const { instructions, signer, recentBlockhash, lastValidBlockHeight } = request;
  const signerAddress = address(getBase58Decoder().decode(await signer.publicKey()));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(signerAddress, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: recentBlockhash as never, lastValidBlockHeight: lastValidBlockHeight ?? 2n ** 64n - 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const compiled = compileTransaction(message);
  const signatureBytes = await signer.sign(Uint8Array.from(compiled.messageBytes));
  const transaction: Transaction = {
    ...compiled,
    signatures: { ...compiled.signatures, [signerAddress]: signatureBytes as SignatureBytes },
  };
  return getBase64EncodedWireTransaction(transaction);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes a base64 wire transaction (round-trip verification and inspection). */
export function decodeTransaction(base64: string): Transaction {
  return getTransactionDecoder().decode(base64ToBytes(base64)) as Transaction;
}

/**
 * A `TransactionBuilder<TInput>` bound to one market: the keeper signer is
 * both the fee payer and the instruction's signing authority, and only the
 * keeper-dependent accounts differ per family.
 */
export interface KeeperTransactionContext {
  programAddress: string;
  /** The market account (writable). */
  market: string;
  /** The keeper signer's address; must equal the signer passed to `build`. */
  authority: string;
}

async function build(signer: Signer, recentBlockhash: string, instructions: Instruction[]): Promise<string> {
  return signAndSerializeTransaction({ instructions, signer, recentBlockhash });
}

function marketAndAuthority(context: KeeperTransactionContext): AccountMeta[] {
  return [meta(context.market, WRITABLE), meta(context.authority, READONLY_SIGNER)];
}

/** `[market (w), authority (signer)]` governance/keeper instructions. */
export function simpleKeeperAccounts(context: KeeperTransactionContext): AccountMeta[] {
  return marketAndAuthority(context);
}

export function fundingKeeperBuilder(context: KeeperTransactionContext): TransactionBuilder<FundingKeeperInput> {
  return {
    build: (input, signer, recentBlockhash) =>
      build(signer, recentBlockhash, [updateFundingInstruction(context.programAddress, marketAndAuthority(context), input.accumulator, BigInt(input.timestamp))]),
  };
}

/** `SessionKeeperInput.targetMode` ('open'/'close-only'/'paused') to this module's `MarketTransition` vocabulary. */
function marketTransitionFor(targetMode: SessionKeeperInput["targetMode"]): MarketTransition {
  return targetMode === "open" ? "resume" : targetMode === "paused" ? "pause" : "close-only";
}

export function sessionKeeperBuilder(context: KeeperTransactionContext & { seatIndex?: number }): TransactionBuilder<SessionKeeperInput> {
  return {
    build: (input, signer, recentBlockhash) =>
      build(signer, recentBlockhash, [transitionMarketInstruction(context.programAddress, marketAndAuthority(context), marketTransitionFor(input.targetMode))]),
  };
}

export function liquidationKeeperBuilder(context: KeeperTransactionContext): TransactionBuilder<LiquidationKeeperInput> {
  return {
    build: (input, signer, recentBlockhash) =>
      build(signer, recentBlockhash, [liquidateInstruction(context.programAddress, marketAndAuthority(context), input.seatIndex, input.maxQuantity)]),
  };
}

export function cleanupKeeperBuilder(context: KeeperTransactionContext & { seatIndex: number }): TransactionBuilder<CleanupKeeperInput> {
  return {
    build: (input, signer, recentBlockhash) =>
      build(signer, recentBlockhash, [cancelAllInstruction(context.programAddress, marketAndAuthority(context), context.seatIndex, input.maxRemovals, 0n)]),
  };
}

/**
 * Pyth: the transaction must carry the Ed25519 pre-instruction at index 0 and
 * the `ConsumeOracleUpdate` at index 1. `ed25519Instruction` is built by the
 * caller from the signed Lazer message (the same message it passes here);
 * this builder wires the indices and the market/oracle accounts.
 */
export function pythKeeperBuilder(
  context: KeeperTransactionContext & { oracleAccounts: AccountMeta[]; ed25519Instruction: Instruction },
): TransactionBuilder<PythKeeperInput> {
  return {
    build: (input, signer, recentBlockhash) =>
      build(signer, recentBlockhash, [
        context.ed25519Instruction,
        consumeOracleUpdateInstruction(context.programAddress, context.oracleAccounts, 0, 0, input.message),
      ]),
  };
}

/**
 * MagicBlock commit keeper: `CommitMarket`/`CommitAndUndelegate` against the
 * ER validator (the caller passes the ER's own recent blockhash, per
 * `runMagicBlockCommitKeeperTick`'s `er.latestBlockhash()`).
 */
export function magicBlockCommitKeeperBuilder(context: KeeperTransactionContext): TransactionBuilder<CommitKeeperInput> {
  return {
    build: (input, signer, recentBlockhash) =>
      build(signer, recentBlockhash, [commitMarketInstruction(context.programAddress, marketAndAuthority(context), BigInt(input.sequence), input.undelegate)]),
  };
}
