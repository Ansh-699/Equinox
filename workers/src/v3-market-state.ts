import { getBase58Decoder } from "@solana/kit";
import type { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";
import { fetchAuthoritativeMarketAccountBytes } from "./market-state";

/** Worker-side V3 shard decoder. It intentionally has no dependency on the
 * web3.js SDK and treats each shard as an independently fetched account. */
export const V3_LAYOUT_VERSION = 3;
export const V3_CORE_SIZE = 4_096;
export const V3_BOOK_PAGE_SIZE = 22_592;
export const V3_SEAT_SHARD_SIZE = 8_236;
export const V3_EVENT_RECORD_SIZE = 100;
export const V3_EVENT_SHARD_SIZE = 3_244;
export const V3_BOOK_NODES_PER_PAGE = 256;
export const V3_BOOK_PAGES_PER_SIDE = 4;
export const V3_SEATS_PER_SHARD = 32;
export const V3_EVENTS_PER_SHARD = 32;

const base58 = getBase58Decoder();
const text = new TextDecoder();

function address(bytes: Uint8Array, offset: number): string {
  return base58.decode(bytes.subarray(offset, offset + 32));
}
function validVersion(bytes: Uint8Array, discriminator: string, size: number): boolean {
  return bytes.length === size
    && text.decode(bytes.subarray(0, 8)) === discriminator
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true) === V3_LAYOUT_VERSION;
}

export interface V3CoreState {
  kind: "v3";
  instrument: string;
  marketAuthority: string;
  mode: number;
  oracleValid: boolean;
  lastVerifiedOraclePrice: bigint;
  lastVerifiedOracleTimestamp: bigint;
  delegationStatus: number;
  expectedCommitSequence: bigint;
  lastCommittedSequence: bigint;
  validator: string;
}

/** Exact offsets mirror `MarketCoreV3` in Rust. `null` means a malformed,
 * V2, or foreign account; callers must not fill defaults for these values. */
export function decodeV3Core(bytes: Uint8Array): V3CoreState | null {
  if (!validVersion(bytes, "STKMK003", V3_CORE_SIZE) || bytes[10] !== 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: "v3",
    mode: bytes[11],
    instrument: address(bytes, 12),
    marketAuthority: address(bytes, 44),
    oracleValid: bytes[180] === 1,
    lastVerifiedOraclePrice: view.getBigInt64(181, true),
    lastVerifiedOracleTimestamp: view.getBigUint64(189, true),
    delegationStatus: bytes[197],
    expectedCommitSequence: view.getBigUint64(198, true),
    lastCommittedSequence: view.getBigUint64(206, true),
    validator: address(bytes, 214),
  };
}

export interface V3BookPageState {
  side: 0 | 1;
  page: number;
  core: string;
  fixedRoot: number;
  peggedRoot: number;
  freeHead: number;
  freeCount: number;
  nodeCount: number;
  /** The 256 raw, 88-byte PATRICIA node slots. Decoding node shape stays in
   * the ABI client; preserving slots here avoids an off-chain BTree facade. */
  nodeBytes: Uint8Array;
}

export function decodeV3BookPage(bytes: Uint8Array): V3BookPageState | null {
  if (!validVersion(bytes, "STKBK003", V3_BOOK_PAGE_SIZE) || bytes[10] > 1 || bytes[11] >= V3_BOOK_PAGES_PER_SIDE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodeCount = view.getUint32(60, true);
  const freeCount = view.getUint32(56, true);
  if (nodeCount > V3_BOOK_NODES_PER_PAGE || freeCount > V3_BOOK_NODES_PER_PAGE) return null;
  return {
    side: bytes[10] as 0 | 1,
    page: bytes[11], core: address(bytes, 12),
    fixedRoot: view.getUint32(44, true), peggedRoot: view.getUint32(48, true),
    freeHead: view.getUint32(52, true), freeCount, nodeCount,
    nodeBytes: bytes.slice(64),
  };
}

export interface V3SeatShardState { shard: number; core: string; seats: Uint8Array; }
export function decodeV3SeatShard(bytes: Uint8Array): V3SeatShardState | null {
  if (!validVersion(bytes, "STKST003", V3_SEAT_SHARD_SIZE) || bytes[10] >= 4 || bytes[11] !== 0) return null;
  return { shard: bytes[10], core: address(bytes, 12), seats: bytes.slice(44) };
}

export interface V3EventShardState { shard: number; core: string; events: Uint8Array; }
export function decodeV3EventShard(bytes: Uint8Array): V3EventShardState | null {
  if (!validVersion(bytes, "STKEV003", V3_EVENT_SHARD_SIZE) || bytes[10] >= 4 || bytes[11] !== 0) return null;
  return { shard: bytes[10], core: address(bytes, 12), events: bytes.slice(44) };
}

export interface V3MarketAggregate {
  core: V3CoreState;
  bookPages: readonly V3BookPageState[];
  seatShards: readonly V3SeatShardState[];
  eventShards: readonly V3EventShardState[];
  /** A complete book needs all 8 pages; durable withdrawal readiness also
   * requires every seat/event shard to be present and the core restored. */
  completeBook: boolean;
  completeExecutionState: boolean;
  withdrawalReady: boolean;
}

/** Rejects duplicates, cross-market substitution, malformed bytes, and
 * incomplete collections. It aggregates only proven shard relationships. */
export function aggregateV3Market(
  coreBytes: Uint8Array,
  bookBytes: readonly Uint8Array[],
  seatBytes: readonly Uint8Array[],
  eventBytes: readonly Uint8Array[],
  coreAddress: string,
): V3MarketAggregate | null {
  const core = decodeV3Core(coreBytes);
  if (!core) return null;
  const books = bookBytes.map(decodeV3BookPage);
  const seats = seatBytes.map(decodeV3SeatShard);
  const events = eventBytes.map(decodeV3EventShard);
  if (books.some((page) => !page || page.core !== coreAddress)
    || seats.some((shard) => !shard || shard.core !== coreAddress)
    || events.some((shard) => !shard || shard.core !== coreAddress)) return null;
  const bookPages = books as V3BookPageState[];
  const seatShards = seats as V3SeatShardState[];
  const eventShards = events as V3EventShardState[];
  const unique = (values: readonly number[]) => new Set(values).size === values.length;
  const completeBook = bookPages.length === 8 && unique(bookPages.map((page) => page.side * 4 + page.page));
  const completeExecutionState = completeBook && seatShards.length === 4 && eventShards.length === 4
    && unique(seatShards.map((shard) => shard.shard)) && unique(eventShards.map((shard) => shard.shard));
  if (!unique(bookPages.map((page) => page.side * 4 + page.page))
    || !unique(seatShards.map((shard) => shard.shard))
    || !unique(eventShards.map((shard) => shard.shard))) return null;
  return {
    core, bookPages, seatShards, eventShards, completeBook, completeExecutionState,
    withdrawalReady: completeExecutionState && core.delegationStatus === 3,
  };
}

export interface V3ShardAddresses {
  core: string;
  bookPages: readonly string[];
  seatShards: readonly string[];
  eventShards: readonly string[];
}

/** Reads a caller-supplied V3 bundle from one authoritative domain. Address
 * derivation belongs in the lifecycle/client layer; this Worker function
 * refuses a wrong cardinality rather than silently omitting an execution
 * shard from readiness decisions. */
export async function fetchAuthoritativeV3Market(
  transport: SolanaL1Transport | MagicRouterTransport,
  addresses: V3ShardAddresses,
): Promise<V3MarketAggregate | null> {
  if (addresses.bookPages.length !== 8 || addresses.seatShards.length !== 4 || addresses.eventShards.length !== 4
    || new Set([addresses.core, ...addresses.bookPages, ...addresses.seatShards, ...addresses.eventShards]).size !== 17) return null;
  const values = await Promise.all([
    fetchAuthoritativeMarketAccountBytes(transport, addresses.core),
    ...addresses.bookPages.map((address) => fetchAuthoritativeMarketAccountBytes(transport, address)),
    ...addresses.seatShards.map((address) => fetchAuthoritativeMarketAccountBytes(transport, address)),
    ...addresses.eventShards.map((address) => fetchAuthoritativeMarketAccountBytes(transport, address)),
  ]);
  if (values.some((value) => value === null)) return null;
  return aggregateV3Market(
    values[0]!, values.slice(1, 9) as Uint8Array[], values.slice(9, 13) as Uint8Array[], values.slice(13, 17) as Uint8Array[], addresses.core,
  );
}
