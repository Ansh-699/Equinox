/**
 * Account layout decoders. Must match the Rust program's packed(1) structs.
 */
import { PublicKey } from "@solana/web3.js";
import { STOCKSTREAM_ACCOUNT_SIZE } from "../constants";
import {
  MARKET_VERSION, BID_ARENA_OFFSET, ASK_ARENA_OFFSET, TRADER_SEAT_OFFSET, FILL_EVENT_OFFSET,
  ORACLE_VALID_OFFSET, ORACLE_PRICE_OFFSET, ORACLE_TIMESTAMP_OFFSET,
  RESERVED_PROTOCOL_FEE_BALANCE, RESERVED_INSURANCE_FUND_BALANCE,
  RESERVED_RECOGNIZED_BAD_DEBT, RESERVED_RECONCILIATION_STATUS, RESERVED_VAULT_SURPLUS,
  RESERVED_DELEGATION_STATUS, RESERVED_VALIDATOR,
} from "./constants";
import { MARKET_MODE, DELEGATION_STATUS, RECONCILIATION_STATUS } from "./instructions";

function readI128(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  const sign = 1n << 127n;
  return v >= sign ? v - (sign << 1n) : v;
}

export interface MarketHeaderView {
  discriminator: string; version: number; initialized: boolean; mode: number;
  marketAuthority: PublicKey; pauseAuthority: PublicKey; emergencyAuthority: PublicKey;
  collateralMint: PublicKey; collateralTokenProgram: PublicKey;
  priceExponent: number; baseLotSize: bigint; quoteLotSize: bigint;
  initialMarginBps: number; maintenanceMarginBps: number; liquidationFeeBps: number;
  makerFeeBps: number; takerFeeBps: number; maximumLeverage: number;
  maximumPosition: bigint; maximumOpenInterest: bigint; currentOpenInterest: bigint;
  globalOrderSequence: bigint; globalEventSequence: bigint;
  fundingAccumulator: bigint; lastFundingTimestamp: bigint;
  oracleValid: boolean; lastVerifiedOraclePrice: bigint; lastVerifiedOracleTimestamp: bigint;
  bidArenaOffset: number; askArenaOffset: number; traderSeatOffset: number; fillEventOffset: number;
  delegationStatus: number; validator: string | null;
  protocolFeeBalance: bigint; insuranceFundBalance: bigint;
  recognizedBadDebt: bigint; reconciliationStatus: number; vaultSurplus: bigint;
}

export function decodeMarketHeader(bytes: Uint8Array, requireInitialized = true): MarketHeaderView | null {
  if (bytes.length < 512) return null;
  const discriminator = new TextDecoder().decode(bytes.subarray(0, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (discriminator !== "STKMRK01" || view.getUint16(8, true) !== MARKET_VERSION) return null;
  if (requireInitialized && view.getUint8(10) !== 1) return null;
  return {
    discriminator, version: view.getUint16(8, true),
    initialized: view.getUint8(10) === 1,
    mode: view.getUint8(11),
    marketAuthority: new PublicKey(bytes.subarray(12, 44)),
    pauseAuthority: new PublicKey(bytes.subarray(44, 76)),
    emergencyAuthority: new PublicKey(bytes.subarray(76, 108)),
    collateralMint: new PublicKey(bytes.subarray(108, 140)),
    collateralTokenProgram: new PublicKey(bytes.subarray(140, 172)),
    priceExponent: view.getInt32(172, true),
    baseLotSize: view.getBigUint64(176, true),
    quoteLotSize: view.getBigUint64(184, true),
    initialMarginBps: view.getUint16(192, true),
    maintenanceMarginBps: view.getUint16(194, true),
    liquidationFeeBps: view.getUint16(196, true),
    makerFeeBps: view.getUint16(198, true),
    takerFeeBps: view.getUint16(200, true),
    maximumLeverage: view.getUint32(202, true),
    maximumPosition: readI128(bytes, 206),
    maximumOpenInterest: readI128(bytes, 222),
    currentOpenInterest: readI128(bytes, 238),
    globalOrderSequence: view.getBigUint64(254, true),
    globalEventSequence: view.getBigUint64(262, true),
    fundingAccumulator: readI128(bytes, 270),
    lastFundingTimestamp: view.getBigUint64(286, true),
    oracleValid: bytes[ORACLE_VALID_OFFSET] === 1,
    lastVerifiedOraclePrice: view.getBigInt64(ORACLE_PRICE_OFFSET, true),
    lastVerifiedOracleTimestamp: view.getBigUint64(ORACLE_TIMESTAMP_OFFSET, true),
    bidArenaOffset: view.getUint32(311, true),
    askArenaOffset: view.getUint32(315, true),
    traderSeatOffset: view.getUint32(319, true),
    fillEventOffset: view.getUint32(323, true),
    delegationStatus: bytes[RESERVED_DELEGATION_STATUS],
    validator: bytes[RESERVED_DELEGATION_STATUS] !== 0
      ? new PublicKey(bytes.subarray(RESERVED_DELEGATION_STATUS + 67, RESERVED_DELEGATION_STATUS + 99)).toBase58()
      : null,
    protocolFeeBalance: view.getBigUint64(RESERVED_PROTOCOL_FEE_BALANCE, true),
    insuranceFundBalance: view.getBigUint64(RESERVED_INSURANCE_FUND_BALANCE, true),
    recognizedBadDebt: view.getBigUint64(RESERVED_RECOGNIZED_BAD_DEBT, true),
    reconciliationStatus: bytes[RESERVED_RECONCILIATION_STATUS],
    vaultSurplus: view.getBigUint64(RESERVED_VAULT_SURPLUS, true),
  };
}

/** Compatibility view used by the legacy client transport. Region and byte
 * layout validation remains owned by this account ABI module. */
export interface MarketStateView {
  discriminator: string; version: number; initialized: boolean; mode: number;
  marketAuthority: PublicKey; emergencyAuthority: PublicKey;
  maintenanceMarginBps: number; makerFeeBps: number; takerFeeBps: number;
  currentOpenInterest: bigint; globalEventSequence: bigint;
  fundingAccumulator: bigint; lastFundingTimestamp: bigint;
  oracleValid: boolean; lastVerifiedOraclePrice: bigint; lastVerifiedOracleTimestamp: bigint;
  bidArenaOffset: number; askArenaOffset: number; traderSeatOffset: number; fillEventOffset: number;
  protocolFeeBalance: bigint; insuranceFundBalance: bigint; recognizedBadDebt: bigint;
  reconciliationStatus: number; vaultSurplus: bigint;
}

export function decodeMarketState(bytes: Uint8Array): MarketStateView {
  if (bytes.byteLength !== STOCKSTREAM_ACCOUNT_SIZE) throw new RangeError("Invalid StockStream market account size");
  // Preserve the historical compatibility decoder's behavior: it rejects
  // wrong version/regions but may inspect an initialization fixture before
  // the initialized bit is set. New account consumers should use the strict
  // default `decodeMarketHeader` path.
  const header = decodeMarketHeader(bytes, false);
  if (!header) throw new RangeError("Invalid StockStream market header");
  if (header.bidArenaOffset !== BID_ARENA_OFFSET || header.askArenaOffset !== ASK_ARENA_OFFSET
      || header.traderSeatOffset !== TRADER_SEAT_OFFSET || header.fillEventOffset !== FILL_EVENT_OFFSET) {
    throw new RangeError("Invalid StockStream regions");
  }
  return {
    discriminator: header.discriminator, version: header.version, initialized: header.initialized, mode: header.mode,
    marketAuthority: header.marketAuthority, emergencyAuthority: header.emergencyAuthority,
    maintenanceMarginBps: header.maintenanceMarginBps, makerFeeBps: header.makerFeeBps, takerFeeBps: header.takerFeeBps,
    currentOpenInterest: header.currentOpenInterest, globalEventSequence: header.globalEventSequence,
    fundingAccumulator: header.fundingAccumulator, lastFundingTimestamp: header.lastFundingTimestamp,
    oracleValid: header.oracleValid, lastVerifiedOraclePrice: header.lastVerifiedOraclePrice,
    lastVerifiedOracleTimestamp: header.lastVerifiedOracleTimestamp, bidArenaOffset: header.bidArenaOffset,
    askArenaOffset: header.askArenaOffset, traderSeatOffset: header.traderSeatOffset, fillEventOffset: header.fillEventOffset,
    protocolFeeBalance: header.protocolFeeBalance, insuranceFundBalance: header.insuranceFundBalance,
    recognizedBadDebt: header.recognizedBadDebt, reconciliationStatus: header.reconciliationStatus, vaultSurplus: header.vaultSurplus,
  };
}
