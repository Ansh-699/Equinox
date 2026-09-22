/** V3 shard ABI. Mirrors programs/stockstream/src/v3.rs. */
import { PublicKey } from "@solana/web3.js";
import {
  ORACLE_SNAPSHOT_AUTHENTICATED_OFFSET, ORACLE_SNAPSHOT_CHANNEL_OFFSET,
  ORACLE_SNAPSHOT_CONFIDENCE_OFFSET, ORACLE_SNAPSHOT_CORE_OFFSET,
  ORACLE_SNAPSHOT_EXPONENT_OFFSET, ORACLE_SNAPSHOT_FEED_ID_OFFSET,
  ORACLE_SNAPSHOT_PRICE_OFFSET, ORACLE_SNAPSHOT_REVISION_OFFSET,
  ORACLE_SNAPSHOT_SEQUENCE_OFFSET, ORACLE_SNAPSHOT_SIZE,
  ORACLE_SNAPSHOT_STATUS_OFFSET, ORACLE_SNAPSHOT_TIMESTAMP_OFFSET,
  ORACLE_SNAPSHOT_VERSION, PROGRAM_ID,
} from "./constants";

const PROGRAM_KEY = new PublicKey(PROGRAM_ID);
export const V3_LAYOUT_VERSION = 3;
export const V3_COMMIT_ACCOUNT_HARD_MAX = 65_535;
export const V3_COMMIT_ACCOUNT_SAFE_MAX = 10_240;
export const V3_MARKET_CORE_SIZE = 4_096;
export const V3_BOOK_PAGE_SIZE = 10_184;
export const V3_SEAT_SHARD_SIZE = 8_236;
export const V3_SEAT_SIZE = 256;
export const V3_EVENT_RECORD_SIZE = 100;
export const V3_EVENT_SHARD_SIZE = 3_244;
export const V3_BOOK_NODES_PER_PAGE = 115;
export const V3_BOOK_PAGES_PER_SIDE = 9;
export const V3_BOOK_SLOTS_PER_SIDE = 1_024;
export const V3_SEATS_PER_SHARD = 32;
export const V3_SEAT_SHARDS = 4;
export const V3_EVENTS_PER_SHARD = 32;
export const V3_EVENT_SHARDS = 4;
export const V3_EXECUTION_BUNDLE_LEN = 27;
export { ORACLE_SNAPSHOT_SIZE };
export const ORACLE_SNAPSHOT_DISCRIMINATOR = "STKORS03";
export { ORACLE_SNAPSHOT_VERSION };
export const V3_CORE_COMMIT_PHASE_OFFSET = 372;
export const V3_CORE_SNAPSHOT_EPOCH_OFFSET = 376;
export const V3_CORE_SNAPSHOT_CHILD_COUNT_OFFSET = 384;
export const V3_CORE_VAULT_SURPLUS_OFFSET = 1640;
export const V3_CORE_WITHDRAWAL_BUFFER_OFFSET = 1656;

export function deriveMarketCoreV3(instrument: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("market-v3"), instrument.toBuffer()], PROGRAM_KEY)[0];
}
export function deriveBookPageV3(market: PublicKey, side: number, page: number): PublicKey {
  if (!Number.isInteger(side) || side < 0 || side > 1 || !Number.isInteger(page) || page < 0 || page >= V3_BOOK_PAGES_PER_SIDE) throw new RangeError("invalid V3 book page");
  return PublicKey.findProgramAddressSync([Buffer.from("book-page-v3"), market.toBuffer(), Buffer.from([side]), Buffer.from([page])], PROGRAM_KEY)[0];
}
export function deriveSeatShardV3(market: PublicKey, shard: number): PublicKey {
  if (!Number.isInteger(shard) || shard < 0 || shard >= V3_SEAT_SHARDS) throw new RangeError("invalid V3 seat shard");
  return PublicKey.findProgramAddressSync([Buffer.from("seat-shard-v3"), market.toBuffer(), Buffer.from([shard])], PROGRAM_KEY)[0];
}
export function deriveEventShardV3(market: PublicKey, shard: number): PublicKey {
  if (!Number.isInteger(shard) || shard < 0 || shard >= V3_EVENT_SHARDS) throw new RangeError("invalid V3 event shard");
  return PublicKey.findProgramAddressSync([Buffer.from("event-shard-v3"), market.toBuffer(), Buffer.from([shard])], PROGRAM_KEY)[0];
}
export function deriveOracleSnapshotV3(core: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("oracle-snapshot-v3"), core.toBuffer()], PROGRAM_KEY)[0];
}
export function v3AccountIsCommittable(size: number): boolean {
  return Number.isInteger(size) && size >= 0 && size <= V3_COMMIT_ACCOUNT_SAFE_MAX && size <= V3_COMMIT_ACCOUNT_HARD_MAX;
}

function versioned(bytes: Uint8Array, discriminator: string, size: number): boolean {
  return bytes.length === size && Buffer.from(bytes.subarray(0, 8)).toString("utf8") === discriminator
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true) === V3_LAYOUT_VERSION;
}
function key(bytes: Uint8Array, offset: number): PublicKey { return new PublicKey(bytes.subarray(offset, offset + 32)); }

/** Exact `MarketCoreV3` decoder. This deliberately does not fall back to
 * V2 offsets: a caller must explicitly select the account-version path. */
export interface V3MarketCoreView {
  instrument: PublicKey; marketAuthority: PublicKey; mode: number;
  oracleValid: boolean; lastVerifiedOraclePrice: bigint; lastVerifiedOracleTimestamp: bigint;
  oracleFeedId: number; oracleChannel: number; oracleExponent: number;
  delegationStatus: number; expectedCommitSequence: bigint; lastCommittedSequence: bigint; validator: PublicKey;
  initialMarginBps: number; maintenanceMarginBps: number; liquidationFeeBps: number;
  makerFeeBps: number; takerFeeBps: number; maximumLeverage: number;
  maximumPosition: bigint; maximumOpenInterest: bigint; currentOpenInterest: bigint;
  markDeviationBps: number; protocolFeeBalance: bigint; insuranceBalance: bigint;
  badDebt: bigint; vaultLiability: bigint; reconciliationStatus: number; riskConfigVersion: number;
  vaultSurplus: bigint; withdrawalBuffer: bigint;
  commitPhase: number; snapshotEpoch: bigint; snapshotChildCount: number;
}
export function decodeV3MarketCore(bytes: Uint8Array): V3MarketCoreView {
  if (!versioned(bytes, "STKMK003", V3_MARKET_CORE_SIZE) || bytes[10] !== 1) throw new RangeError("Invalid V3 market core");
  if (bytes[371] !== 2) throw new RangeError("Unsupported V3 risk layout: revision 2 required");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mode: bytes[11], instrument: key(bytes, 12), marketAuthority: key(bytes, 44), oracleValid: bytes[180] === 1,
    lastVerifiedOraclePrice: view.getBigInt64(181, true), lastVerifiedOracleTimestamp: view.getBigUint64(189, true),
    oracleFeedId: view.getUint32(246, true), oracleChannel: bytes[250], oracleExponent: view.getInt32(251, true),
    delegationStatus: bytes[197], expectedCommitSequence: view.getBigUint64(198, true),
    lastCommittedSequence: view.getBigUint64(206, true), validator: key(bytes, 214),
    initialMarginBps: view.getUint16(1672, true), maintenanceMarginBps: view.getUint16(1674, true),
    liquidationFeeBps: view.getUint16(1676, true), makerFeeBps: view.getUint16(1678, true),
    takerFeeBps: view.getUint16(1680, true), maximumLeverage: view.getUint32(1682, true),
    maximumPosition: signed128(view, 256), maximumOpenInterest: signed128(view, 272),
    currentOpenInterest: signed128(view, 288), markDeviationBps: view.getUint16(304, true),
    protocolFeeBalance: signed128(view, 306), insuranceBalance: signed128(view, 322),
    badDebt: signed128(view, 338), vaultLiability: signed128(view, 354),
    reconciliationStatus: bytes[370], riskConfigVersion: bytes[371],
    vaultSurplus: signed128(view, V3_CORE_VAULT_SURPLUS_OFFSET), withdrawalBuffer: signed128(view, V3_CORE_WITHDRAWAL_BUFFER_OFFSET),
    commitPhase: bytes[V3_CORE_COMMIT_PHASE_OFFSET], snapshotEpoch: view.getBigUint64(V3_CORE_SNAPSHOT_EPOCH_OFFSET, true),
    snapshotChildCount: view.getUint32(V3_CORE_SNAPSHOT_CHILD_COUNT_OFFSET, true),
  };
}

export interface OracleSnapshotV3View {
  core: PublicKey; feedId: number; channel: number; exponent: number;
  price: bigint; confidence: bigint; publishTimestamp: bigint; sequence: bigint;
  session: number; tradingStatus: number; authenticated: boolean;
  revision: number;
}
export function decodeOracleSnapshotV3(bytes: Uint8Array): OracleSnapshotV3View {
  if (bytes.length !== ORACLE_SNAPSHOT_SIZE || Buffer.from(bytes.subarray(0, 8)).toString("utf8") !== ORACLE_SNAPSHOT_DISCRIMINATOR) throw new RangeError("Invalid oracle snapshot");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, true) !== ORACLE_SNAPSHOT_VERSION || bytes[10] !== 1 || bytes[ORACLE_SNAPSHOT_AUTHENTICATED_OFFSET] !== 1) throw new RangeError("Invalid oracle snapshot version/authentication");
  return { core: key(bytes, ORACLE_SNAPSHOT_CORE_OFFSET), feedId: view.getUint32(ORACLE_SNAPSHOT_FEED_ID_OFFSET, true), channel: bytes[ORACLE_SNAPSHOT_CHANNEL_OFFSET], exponent: view.getInt32(ORACLE_SNAPSHOT_EXPONENT_OFFSET, true), price: view.getBigInt64(ORACLE_SNAPSHOT_PRICE_OFFSET, true), confidence: view.getBigUint64(ORACLE_SNAPSHOT_CONFIDENCE_OFFSET, true), publishTimestamp: view.getBigUint64(ORACLE_SNAPSHOT_TIMESTAMP_OFFSET, true), sequence: view.getBigUint64(ORACLE_SNAPSHOT_SEQUENCE_OFFSET, true), session: bytes[85], tradingStatus: bytes[ORACLE_SNAPSHOT_STATUS_OFFSET], authenticated: true, revision: bytes[ORACLE_SNAPSHOT_REVISION_OFFSET] };
}

export interface V3BookPageView {
  side: 0 | 1; page: number; market: PublicKey; fixedRoot: number; peggedRoot: number;
  freeHead: number; freeCount: number; nodeCount: number; nodes: Uint8Array;
}

export interface V3SeatPositionView {
  shard: number; slot: number; trader: PublicKey; availableCollateral: bigint; reservedMargin: bigint;
  basePosition: bigint; quoteEntryValue: bigint; realizedPnl: bigint; openBidExposure: bigint;
  openAskExposure: bigint; openOrderCount: number; liquidationState: number; sequence: bigint;
}
function signed128(view: DataView, offset: number): bigint {
  const value = view.getBigUint64(offset, true) | (view.getBigUint64(offset + 8, true) << 64n);
  return value >= (1n << 127n) ? value - (1n << 128n) : value;
}
export interface V3SeatShardView { shard: number; market: PublicKey; positions: readonly V3SeatPositionView[]; }
export function decodeV3SeatShard(bytes: Uint8Array): V3SeatShardView {
  if (!versioned(bytes, "STKST003", V3_SEAT_SHARD_SIZE) || bytes[10] >= V3_SEAT_SHARDS || bytes[11] !== 0) throw new RangeError("Invalid V3 seat shard");
  const positions = Array.from({ length: V3_SEATS_PER_SHARD }, (_, slot) => {
    const base = 44 + slot * V3_SEAT_SIZE;
    if (bytes[base] === 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + base, V3_SEAT_SIZE);
    return {
      shard: bytes[10], slot, trader: new PublicKey(bytes.subarray(base + 1, base + 33)), availableCollateral: signed128(view, 40),
      reservedMargin: signed128(view, 56), basePosition: signed128(view, 72), quoteEntryValue: signed128(view, 88),
      realizedPnl: signed128(view, 104), openBidExposure: signed128(view, 136), openAskExposure: signed128(view, 152),
      openOrderCount: view.getUint32(168, true), liquidationState: bytes[base + 172], sequence: view.getBigUint64(176, true),
    } satisfies V3SeatPositionView;
  }).filter((position): position is V3SeatPositionView => position !== null);
  return { shard: bytes[10], market: key(bytes, 12), positions };
}

export interface V3EventRecordView { kind: number; sequence: bigint; timestamp: bigint; payload: Uint8Array; }
export function decodeV3EventRecord(bytes: Uint8Array): V3EventRecordView | null {
  if (bytes.length !== V3_EVENT_RECORD_SIZE) throw new RangeError("Invalid V3 event record");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint16(0, true);
  if (kind === 0) return null;
  return { kind, sequence: view.getBigUint64(4, true), timestamp: view.getBigUint64(44, true), payload: bytes.slice(52) };
}

export interface V3EventShardView { shard: number; market: PublicKey; records: readonly (V3EventRecordView | null)[]; }
export function decodeV3EventShard(bytes: Uint8Array): V3EventShardView {
  if (!versioned(bytes, "STKEV003", V3_EVENT_SHARD_SIZE) || bytes[10] >= V3_EVENT_SHARDS || bytes[11] !== 0) throw new RangeError("Invalid V3 event shard");
  const records = Array.from({ length: V3_EVENTS_PER_SHARD }, (_, index) => decodeV3EventRecord(bytes.slice(44 + index * V3_EVENT_RECORD_SIZE, 44 + (index + 1) * V3_EVENT_RECORD_SIZE)));
  return { shard: bytes[10], market: key(bytes, 12), records };
}
export function decodeV3BookPage(bytes: Uint8Array): V3BookPageView {
  if (!versioned(bytes, "STKBK003", V3_BOOK_PAGE_SIZE) || bytes[10] > 1 || bytes[11] >= V3_BOOK_PAGES_PER_SIDE) throw new RangeError("Invalid V3 book page");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const freeCount = view.getUint32(56, true); const nodeCount = view.getUint32(60, true);
  const limit = bytes[11] === 0 ? V3_BOOK_SLOTS_PER_SIDE : V3_BOOK_NODES_PER_PAGE;
  if (freeCount > limit || nodeCount > limit) throw new RangeError("Invalid V3 book page metadata");
  return { side: bytes[10] as 0 | 1, page: bytes[11], market: key(bytes, 12), fixedRoot: view.getUint32(44, true), peggedRoot: view.getUint32(48, true), freeHead: view.getUint32(52, true), freeCount, nodeCount, nodes: bytes.slice(64) };
}
