import { PublicKey, SystemProgram } from "@solana/web3.js";
import { STOCKSTREAM_PROGRAM_ID } from "./constants";
import { cancelAllV3, cancelOrderV3, closeV3TraderSeat, commitMarketV3, commitV3Shard, consumeOracleUpdateV3, createV3Account, createV3TraderSeat, delegateV3Account, depositCollateralV3, initializeV3Market, placeOrderV3, replaceOrderV3, requestV3Undelegation, rollbackV3Undelegation, updateFundingV3, withdrawCollateralV3 } from "./abi/v3-instructions";
import { authorizeTradingSession, closeTradingSession, deriveTradingSession, revokeTradingSession, updateTradingSessionLimits } from "./abi/session-instructions";
import { createPerpMarket, initializeExchange, registerStockInstrument, suspendStockInstrument, transitionMarket, updateMarketRisk, updateStockInstrument } from "./abi/registry-instructions";
import { depositCollateral, initializeVault, reconcileVault, recordBadDebt, resolveBadDebt, transferToInsuranceFund, withdrawCollateral, withdrawInsuranceFunds, withdrawProtocolFees } from "./abi/custody-instructions";
import { cancelAll, cancelOrder, closeTraderSeat, createTraderSeat, initializeMarket, initializeSettlementScratch, liquidate, placeOrder, replaceOrder, updateFunding } from "./abi/order-instructions";
import type { PlaceOrderParams } from "./abi/order-instructions";
import { consumeOracleUpdate } from "./abi/oracle-instructions";
import { commitAndUndelegate, commitMarket, delegateClusterMember, delegateMarket, deriveClusterMemberPdas } from "./abi/magicblock-instructions";
import { updateExchangeConfig } from "./abi/exchange-config-instructions";
import { EVENT_ABI_VERSION, EVENT_HEADER_SIZE, EVENT_KIND_NAMES, EVENT_PAYLOAD_SIZE, EVENT_SIZE, NO_SEAT } from "./abi/events";
import { decodeTradingSession as decodeTradingSessionAbi, type TradingSessionView as TradingSessionAbiView } from "./abi/sessions";

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
export { TRADING_SESSION_DISCRIMINATOR, TRADING_SESSION_VERSION } from "./abi/sessions";
export {
  decodeDelegationPayload, decodeFillPayload, decodeFundingPayload,
  decodeLiquidationPayload, decodeOraclePayload, decodeOrderPayload,
  decodePositionPayload, decodeReconciliationPayload, decodeRegistryPayload,
  decodeSeatAmountPayload, decodeSeatPayload, decodeSessionPayload,
  decodeStockStreamEvent,
} from "./abi/event-decoders";
export type { StockStreamEvent } from "./abi/event-decoders";
export { decodeBookMetadata, decodeFillEvent } from "./abi/legacy-decoders";
export type { BookMetadata, FillEventView } from "./abi/legacy-decoders";

export { STOCKSTREAM_PROGRAM_KEY } from "./abi/transaction";
export type { AddressInput } from "./abi/transaction";
export { decodeInstruction } from "./abi/instructions";
export type { InstructionFixture } from "./abi/instructions";
export { decodeMarketState } from "./abi/accounts";
export type { MarketStateView } from "./abi/accounts";

/** Account tuple for opcode 46. `parent` is an instrument for `core`, and a V3 core otherwise. */

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

/**
 * Compatibility facade for the canonical ABI decoder. The ABI module uses
 * base58 strings for Worker portability; the legacy public client API keeps
 * `PublicKey` fields and its strict-throw behavior for malformed accounts.
 */
export function decodeTradingSession(data: Uint8Array): TradingSessionView {
  const decoded: TradingSessionAbiView | null = decodeTradingSessionAbi(data);
  if (!decoded) throw new RangeError("Invalid TradingSession account");
  return {
    ...decoded,
    owner: new PublicKey(decoded.owner),
    sessionSigner: new PublicKey(decoded.sessionSigner),
    targetProgram: new PublicKey(decoded.targetProgram),
    market: new PublicKey(decoded.market),
    maxExposure: decoded.maximumExposure,
    maxOpenOrders: decoded.maximumOpenOrders,
  };
}

export function previewPlaceOrder(params: PlaceOrderParams) {
  const tx = placeOrder(params);
  return { programId: STOCKSTREAM_PROGRAM_ID, instruction: "PlaceOrder", accounts: tx.keys.map((account) => ({ address: account.pubkey.toBase58(), signer: account.isSigner, writable: account.isWritable })), signers: tx.keys.filter((account) => account.isSigner).map((account) => account.pubkey.toBase58()), side: params.side, quantity: String(params.quantity), limitPrice: String(params.priceOrOffset), estimatedInternalMargin: "Unavailable until verified oracle pricing" };
}

export { SystemProgram };
