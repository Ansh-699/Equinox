import { PublicKey, SystemProgram } from "@solana/web3.js";
import { STOCKSTREAM_PROGRAM_ID, STOCKSTREAM_TRADING_SESSION_SIZE } from "./constants";
import { cancelAllV3, cancelOrderV3, closeV3TraderSeat, commitMarketV3, commitV3Shard, consumeOracleUpdateV3, createV3Account, createV3TraderSeat, delegateV3Account, depositCollateralV3, initializeV3Market, placeOrderV3, replaceOrderV3, requestV3Undelegation, rollbackV3Undelegation, updateFundingV3, withdrawCollateralV3 } from "./abi/v3-instructions";
import { authorizeTradingSession, closeTradingSession, deriveTradingSession, revokeTradingSession, updateTradingSessionLimits } from "./abi/session-instructions";
import { createPerpMarket, initializeExchange, registerStockInstrument, suspendStockInstrument, transitionMarket, updateMarketRisk, updateStockInstrument } from "./abi/registry-instructions";
import { depositCollateral, initializeVault, reconcileVault, recordBadDebt, resolveBadDebt, transferToInsuranceFund, withdrawCollateral, withdrawInsuranceFunds, withdrawProtocolFees } from "./abi/custody-instructions";
import { cancelAll, cancelOrder, closeTraderSeat, createTraderSeat, initializeMarket, initializeSettlementScratch, liquidate, placeOrder, replaceOrder, updateFunding } from "./abi/order-instructions";
import type { PlaceOrderParams } from "./abi/order-instructions";
import { consumeOracleUpdate } from "./abi/oracle-instructions";
import { commitAndUndelegate, commitMarket, delegateClusterMember, delegateMarket, deriveClusterMemberPdas } from "./abi/magicblock-instructions";
import { updateExchangeConfig } from "./abi/exchange-config-instructions";
import { decodeDelegationPayload as decodeDelegationPayloadAbi, decodeFillPayload as decodeFillPayloadAbi, decodeFundingPayload as decodeFundingPayloadAbi, decodeLiquidationPayload as decodeLiquidationPayloadAbi, decodeOraclePayload as decodeOraclePayloadAbi, decodeOrderPayload as decodeOrderPayloadAbi, decodePositionPayload as decodePositionPayloadAbi, decodeReconciliationPayload as decodeReconciliationPayloadAbi, decodeRegistryPayload as decodeRegistryPayloadAbi, decodeSeatAmountPayload as decodeSeatAmountPayloadAbi, decodeSeatPayload as decodeSeatPayloadAbi, decodeSessionPayload as decodeSessionPayloadAbi, decodeStockStreamEvent as decodeStockStreamEventAbi } from "./abi/event-decoders";
import { decodeBookMetadata as decodeBookMetadataAbi, decodeFillEvent as decodeFillEventAbi } from "./abi/legacy-decoders";
import { EVENT_ABI_VERSION, EVENT_HEADER_SIZE, EVENT_KIND_NAMES, EVENT_PAYLOAD_SIZE, EVENT_SIZE, NO_SEAT } from "./abi/events";

export { cancelAllV3, cancelOrderV3, closeV3TraderSeat, commitMarketV3, commitV3Shard, consumeOracleUpdateV3, createV3Account, createV3TraderSeat, delegateV3Account, depositCollateralV3, initializeV3Market, placeOrderV3, replaceOrderV3, requestV3Undelegation, rollbackV3Undelegation, updateFundingV3, withdrawCollateralV3 } from "./abi/v3-instructions";
export type { V3AccountKind, V3CommitAccounts, V3CreationAccounts, V3DelegationAccounts, V3DepositAccounts, V3ExecutionAccounts, V3FundingAccounts, V3InitializationAccounts, V3OracleAccounts, V3SeatAccounts, V3ShardCommitAccounts, V3UndelegationRecoveryAccounts, V3WithdrawAccounts } from "./abi/v3-instructions";
export { SESSION_ACTION, authorizeTradingSession, closeTradingSession, deriveTradingSession, revokeTradingSession, updateTradingSessionLimits } from "./abi/session-instructions";
export type { SessionControlAccounts, TradingSessionAccounts, TradingSessionPolicy } from "./abi/session-instructions";
export { createPerpMarket, initializeExchange, registerStockInstrument, suspendStockInstrument, transitionMarket, updateMarketRisk, updateStockInstrument } from "./abi/registry-instructions";
export type { InstrumentAccounts, MarketAuthorityAccounts, MarketTransition, PerpMarketAccounts, RegistryAccounts } from "./abi/registry-instructions";
export { depositCollateral, initializeVault, reconcileVault, recordBadDebt, resolveBadDebt, transferToInsuranceFund, withdrawCollateral, withdrawInsuranceFunds, withdrawProtocolFees } from "./abi/custody-instructions";
export type { BadDebtAccounts, CustodyAccounts, InsuranceTransferAccounts, LedgerWithdrawalAccounts, ReconcileAccounts, VaultAccounts } from "./abi/custody-instructions";
export { cancelAll, cancelOrder, closeTraderSeat, createTraderSeat, initializeMarket, initializeSettlementScratch, liquidate, placeOrder, replaceOrder, updateFunding } from "./abi/order-instructions";
export type { InstructionAccounts, OrderTree, PlaceOrderParams, SelfTradeBehavior, SessionAuthorizedAccounts, Side } from "./abi/order-instructions";
export { CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET, consumeOracleUpdate } from "./abi/oracle-instructions";
export type { ConsumeOracleUpdateAccounts } from "./abi/oracle-instructions";
export { MAGICBLOCK_DELEGATION_PROGRAM_ID, MAGICBLOCK_MAGIC_CONTEXT_ID, MAGICBLOCK_MAGIC_PROGRAM_ID, commitAndUndelegate, commitMarket, delegateClusterMember, delegateMarket, deriveClusterMemberPdas } from "./abi/magicblock-instructions";
export type { ClusterMemberAccounts, CommitAccounts, DelegationAccounts } from "./abi/magicblock-instructions";
export { EXCHANGE_CONFIG_FIELD, updateExchangeConfig } from "./abi/exchange-config-instructions";
export type { UpdateExchangeConfigFields } from "./abi/exchange-config-instructions";
export { EVENT_ABI_VERSION, EVENT_HEADER_SIZE, EVENT_KIND_NAMES, EVENT_PAYLOAD_SIZE, EVENT_SIZE, NO_SEAT } from "./abi/events";

export { STOCKSTREAM_PROGRAM_KEY } from "./abi/transaction";
export type { AddressInput } from "./abi/transaction";
export { decodeInstruction } from "./abi/instructions";
export type { InstructionFixture } from "./abi/instructions";
export { decodeMarketState } from "./abi/accounts";
export type { MarketStateView } from "./abi/accounts";

/** Account tuple for opcode 46. `parent` is an instrument for `core`, and a V3 core otherwise. */

// ---------------------------------------------------------------------
// Priority 7: the complete, versioned, binary StockStream event ABI
// (`programs/stockstream/src/events.rs`). Every event is one real
// `sol_log_data` syscall call, surfacing in `meta.logMessages` as a single
// `Program data: <base64>` line carrying exactly `EVENT_SIZE` (100) bytes:
// a fixed header (discriminator, ABI version, sequence, market, timestamp)
// followed by a fixed 48-byte payload whose fields depend on the
// discriminator. This replaced the earlier Priority-4 custody-only
// `SS:<Kind> ...` text format (`Program log:` lines via `pinocchio_log`)
// with this single ABI covering every event category.
// ---------------------------------------------------------------------

export interface StockStreamEvent {
  discriminator: number;
  /** Human-readable name for a known discriminator, or `Unknown(<n>)` for
   * a future/unrecognized one -- the raw discriminator and payload are
   * still returned so an indexer can preserve the record rather than
   * dropping it. */
  kind: string;
  abiVersion: number;
  sequence: bigint;
  /** 64-character lowercase hex market pubkey. */
  market: string;
  timestamp: bigint;
  /** The raw 48-byte payload; use the `decode*Payload` helpers below for
   * the shape matching this event's `kind`. */
  payload: Uint8Array;
}

/**
 * Decodes one StockStream event out of a transaction log line. Returns
 * `null` for a line that isn't a `Program data:` record, that fails to
 * base64-decode, or whose decoded length doesn't exactly match `EVENT_SIZE`
 * (a truncated or foreign record) -- never for an unrecognized
 * discriminator, since a future ABI version's new event kinds should still
 * be preserved (`kind` becomes `Unknown(<n>)`), not silently dropped.
 */
export function decodeStockStreamEvent(logLine: string): StockStreamEvent | null {
  return decodeStockStreamEventAbi(logLine);
}

/** `events::payload_seat`. */
export function decodeSeatPayload(payload: Uint8Array) {
  return decodeSeatPayloadAbi(payload);
}
/** `events::payload_seat_amount`. */
export function decodeSeatAmountPayload(payload: Uint8Array) {
  return decodeSeatAmountPayloadAbi(payload);
}
/** `events::payload_order`. */
export function decodeOrderPayload(payload: Uint8Array) {
  return decodeOrderPayloadAbi(payload);
}
/** `events::payload_fill`. */
export function decodeFillPayload(payload: Uint8Array) {
  return decodeFillPayloadAbi(payload);
}
/** `events::payload_position`. */
export function decodePositionPayload(payload: Uint8Array) {
  return decodePositionPayloadAbi(payload);
}
/** `events::payload_funding`. */
export function decodeFundingPayload(payload: Uint8Array) {
  return decodeFundingPayloadAbi(payload);
}
/** `events::payload_liquidation`. */
export function decodeLiquidationPayload(payload: Uint8Array) {
  return decodeLiquidationPayloadAbi(payload);
}
/** `events::payload_oracle`. */
export function decodeOraclePayload(payload: Uint8Array) {
  return decodeOraclePayloadAbi(payload);
}
/** `events::payload_delegation`. */
export function decodeDelegationPayload(payload: Uint8Array) {
  return decodeDelegationPayloadAbi(payload);
}
/** `events::payload_session`. */
export function decodeSessionPayload(payload: Uint8Array) {
  return decodeSessionPayloadAbi(payload);
}
/** `events::payload_registry`. */
export function decodeRegistryPayload(payload: Uint8Array) {
  return decodeRegistryPayloadAbi(payload);
}
/** `events::payload_reconciliation`. */
export function decodeReconciliationPayload(payload: Uint8Array) {
  return decodeReconciliationPayloadAbi(payload);
}

/**
 * The signed Pyth message is embedded at byte offset 4 of this
 * instruction's own data (after the tag + `ed25519_instruction_index` +
 * `signature_index`); the Ed25519 precompile instruction the keeper places
 * before this one must reference that exact offset. `ed25519InstructionIndex`
 * and `signatureIndex` are not assumed by the program -- it independently
 * inspects the Instructions sysvar to confirm they name a real, preceding
 * Ed25519-program instruction before trusting them (and before the CPI into
 * Pyth's own `verify_message`, which repeats the check authoritatively).
 * See `handlers::consume_oracle_update` in the Rust program.
 */
// There is no client-side `undelegationCallback` builder: the delegation
// program itself invokes StockStream via CPI using its own fixed
// `EXTERNAL_UNDELEGATE_DISCRIMINATOR` wire format
// (`[196, 28, 41, 206, 48, 37, 51, 167]`), never a transaction a client
// constructs. See `programs/stockstream/src/magicblock.rs::external_undelegate`.
/**
 * Creates or resumes exactly one committable V3 account. For a book page,
 * the target is 10,184 bytes and completes in one System CPI; retries after
 * completion are idempotent. The builder validates the target PDA so a
 * client cannot accidentally point this isolated V3 flow at the V2 market.
 */
export interface BookMetadata { version: number; fixedRoot: number; peggedRoot: number; fixedLeaves: number; peggedLeaves: number; bumpIndex: number; freeHead: number; freeLength: number; }
export function decodeBookMetadata(data: Uint8Array): BookMetadata {
  return decodeBookMetadataAbi(data);
}

export interface FillEventView { sequence: bigint; maker: number; taker: number; price: bigint; quantity: bigint; }
export function decodeFillEvent(data: Uint8Array): FillEventView {
  return decodeFillEventAbi(data);
}

function readSignedLE(data: Uint8Array, offset: number, bytes: number): bigint {
  let value = 0n;
  for (let i = bytes - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]);
  const signBit = 1n << BigInt(bytes * 8 - 1);
  return value >= signBit ? value - (signBit << 1n) : value;
}

export interface TradingSessionView {
  discriminator: string;
  version: number;
  initialized: boolean;
  revoked: boolean;
  owner: PublicKey;
  sessionSigner: PublicKey;
  targetProgram: PublicKey;
  market: PublicKey;
  traderSeatIndex: number;
  createdAt: bigint;
  expiresAt: bigint;
  actions: number;
  maxOrderNotional: bigint;
  maxCumulativeNotional: bigint;
  consumedCumulativeNotional: bigint;
  maxExposure: bigint;
  maxOpenOrders: number;
  nextExpectedNonce: bigint;
  lastActionTimestamp: bigint;
  sessionGeneration: number;
}

/** Must match `session::TradingSession`'s packed byte layout exactly. */
export function decodeTradingSession(data: Uint8Array): TradingSessionView {
  if (data.byteLength !== STOCKSTREAM_TRADING_SESSION_SIZE) throw new RangeError("Invalid TradingSession account size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const discriminator = new TextDecoder().decode(data.slice(0, 8));
  if (discriminator !== "STKSES02" || view.getUint16(8, true) !== 1) throw new RangeError("Invalid TradingSession header");
  return {
    discriminator,
    version: view.getUint16(8, true),
    initialized: view.getUint8(10) === 1,
    revoked: view.getUint8(11) === 1,
    owner: new PublicKey(data.slice(12, 44)),
    sessionSigner: new PublicKey(data.slice(44, 76)),
    targetProgram: new PublicKey(data.slice(76, 108)),
    market: new PublicKey(data.slice(108, 140)),
    traderSeatIndex: view.getUint16(140, true),
    createdAt: view.getBigUint64(142, true),
    expiresAt: view.getBigUint64(150, true),
    actions: view.getUint8(158),
    maxOrderNotional: view.getBigUint64(159, true),
    maxCumulativeNotional: view.getBigUint64(167, true),
    consumedCumulativeNotional: view.getBigUint64(175, true),
    maxExposure: readSignedLE(data, 183, 16),
    maxOpenOrders: view.getUint16(199, true),
    nextExpectedNonce: view.getBigUint64(201, true),
    lastActionTimestamp: view.getBigUint64(209, true),
    sessionGeneration: view.getUint32(217, true),
  };
}

export function previewPlaceOrder(params: PlaceOrderParams) {
  const tx = placeOrder(params);
  return { programId: STOCKSTREAM_PROGRAM_ID, instruction: "PlaceOrder", accounts: tx.keys.map((account) => ({ address: account.pubkey.toBase58(), signer: account.isSigner, writable: account.isWritable })), signers: tx.keys.filter((account) => account.isSigner).map((account) => account.pubkey.toBase58()), side: params.side, quantity: String(params.quantity), limitPrice: String(params.priceOrOffset), estimatedInternalMargin: "Unavailable until verified oracle pricing" };
}

export { SystemProgram };
