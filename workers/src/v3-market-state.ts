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
export const V3_NODE_SIZE = 88;
export const V3_SEAT_SIZE = 256;

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
  nodes: readonly V3BookNodeState[];
}

export interface V3BookNodeState {
  handle: number;
  tag: 1 | 2;
  key: bigint;
  side?: 0 | 1;
  owner?: number;
  quantity?: bigint;
  expiresAt?: bigint;
  sequence?: bigint;
}

function nodeKey(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (view.getBigUint64(16, true) << 64n) | view.getBigUint64(8, true);
}
function decodeBookNode(bytes: Uint8Array, handle: number): V3BookNodeState | null {
  if (bytes.length !== V3_NODE_SIZE) return null;
  const tag = bytes[0];
  if (tag !== 1 && tag !== 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base: V3BookNodeState = { handle, tag, key: nodeKey(bytes) };
  if (tag === 1) return base;
  return { ...base, side: bytes[1] as 0 | 1, owner: view.getUint32(4, true), quantity: view.getBigUint64(24, true), expiresAt: view.getBigUint64(32, true), sequence: view.getBigUint64(64, true) };
}

export function decodeV3BookPage(bytes: Uint8Array): V3BookPageState | null {
  if (!validVersion(bytes, "STKBK003", V3_BOOK_PAGE_SIZE) || bytes[10] > 1 || bytes[11] >= V3_BOOK_PAGES_PER_SIDE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodeCount = view.getUint32(60, true);
  const freeCount = view.getUint32(56, true);
  const limit = bytes[11] === 0 ? V3_BOOK_PAGES_PER_SIDE * V3_BOOK_NODES_PER_PAGE : V3_BOOK_NODES_PER_PAGE;
  if (nodeCount > limit || freeCount > limit) return null;
  const nodeBytes = bytes.slice(64);
  const nodes = Array.from({ length: V3_BOOK_NODES_PER_PAGE }, (_, index) => decodeBookNode(nodeBytes.slice(index * V3_NODE_SIZE, (index + 1) * V3_NODE_SIZE), bytes[11] * V3_BOOK_NODES_PER_PAGE + index)).filter((node): node is V3BookNodeState => node !== null);
  return {
    side: bytes[10] as 0 | 1,
    page: bytes[11], core: address(bytes, 12),
    fixedRoot: view.getUint32(44, true), peggedRoot: view.getUint32(48, true),
    freeHead: view.getUint32(52, true), freeCount, nodeCount,
    nodeBytes, nodes,
  };
}

export interface V3SeatPositionState {
  shard: number; slot: number; trader: string; availableCollateral: bigint; reservedMargin: bigint;
  basePosition: bigint; quoteEntryValue: bigint; realizedPnl: bigint; openBidExposure: bigint;
  openAskExposure: bigint; openOrderCount: number; liquidationState: number; sequence: bigint;
}
function signed128(view: DataView, offset: number): bigint {
  const value = view.getBigUint64(offset, true) | (view.getBigUint64(offset + 8, true) << 64n);
  return value >= (1n << 127n) ? value - (1n << 128n) : value;
}
function decodeSeat(bytes: Uint8Array, shard: number, slot: number): V3SeatPositionState | null {
  if (bytes.length !== V3_SEAT_SIZE || bytes[0] === 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    shard, slot, trader: address(bytes, 1), availableCollateral: signed128(view, 40), reservedMargin: signed128(view, 56),
    basePosition: signed128(view, 72), quoteEntryValue: signed128(view, 88), realizedPnl: signed128(view, 104),
    openBidExposure: signed128(view, 136), openAskExposure: signed128(view, 152), openOrderCount: view.getUint32(168, true),
    liquidationState: bytes[172], sequence: view.getBigUint64(176, true),
  };
}
export interface V3SeatShardState { shard: number; core: string; seats: Uint8Array; positions: readonly V3SeatPositionState[]; }
export function decodeV3SeatShard(bytes: Uint8Array): V3SeatShardState | null {
  if (!validVersion(bytes, "STKST003", V3_SEAT_SHARD_SIZE) || bytes[10] >= 4 || bytes[11] !== 0) return null;
  const seats = bytes.slice(44);
  const positions = Array.from({ length: V3_SEATS_PER_SHARD }, (_, index) => decodeSeat(seats.slice(index * V3_SEAT_SIZE, (index + 1) * V3_SEAT_SIZE), bytes[10], index)).filter((seat): seat is V3SeatPositionState => seat !== null);
  return { shard: bytes[10], core: address(bytes, 12), seats, positions };
}

export interface V3EventRecord { kind: number; sequence: bigint; timestamp: bigint; payload: Uint8Array; }
export function decodeV3EventRecord(bytes: Uint8Array): V3EventRecord | null {
  if (bytes.length !== V3_EVENT_RECORD_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint16(0, true);
  if (kind === 0) return null;
  return { kind, sequence: view.getBigUint64(4, true), timestamp: view.getBigUint64(44, true), payload: bytes.slice(52) };
}
export interface V3EventShardState { shard: number; core: string; events: Uint8Array; records: readonly (V3EventRecord | null)[]; }
export function decodeV3EventShard(bytes: Uint8Array): V3EventShardState | null {
  if (!validVersion(bytes, "STKEV003", V3_EVENT_SHARD_SIZE) || bytes[10] >= 4 || bytes[11] !== 0) return null;
  const events = bytes.slice(44);
  const records = Array.from({ length: V3_EVENTS_PER_SHARD }, (_, index) => decodeV3EventRecord(events.slice(index * V3_EVENT_RECORD_SIZE, (index + 1) * V3_EVENT_RECORD_SIZE)));
  return { shard: bytes[10], core: address(bytes, 12), events, records };
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
  orderBook: { bids: readonly V3BookNodeState[]; asks: readonly V3BookNodeState[] };
  positions: readonly V3SeatPositionState[];
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
  const leaves = bookPages.flatMap((page) => page.nodes).filter((node) => node.tag === 2);
  return {
    core, bookPages, seatShards, eventShards, completeBook, completeExecutionState,
    withdrawalReady: completeExecutionState && core.delegationStatus === 3,
    orderBook: {
      bids: leaves.filter((node) => node.side === 0).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
      asks: leaves.filter((node) => node.side === 1).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    },
    positions: seatShards.flatMap((shard) => shard.positions),
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
