/**
 * Worker-side projection of the program's deterministic executable mark
 * price (`programs/stockstream/src/mark.rs`). This is a PARITY PORT, not an
 * independent policy: the exact same rules and integer arithmetic, applied
 * to the same market-account bytes the program reads, so a UI showing the
 * mark always shows the number the program itself computes.
 *
 * Byte layout ground truth (verified against the Rust repr(C) definitions):
 * - header (512 bytes): oracleValid @294, lastVerifiedOraclePrice @295
 *   (i64 LE), lastVerifiedOracleTimestamp @303 (u64 LE), reserved_upgrade
 *   starts @327; `RESERVED_MAX_MARK_DEVIATION_BPS` is reserved_upgrade[156]
 *   (i16 LE, 0 = default) -> absolute bytes 483..485.
 * - Arena (90,640 bytes, starts at 512 / 91,152): version @0, roots
 *   [u32;2] @4..12, `nodes: [AnyNode; 1024]` @524 (AnyNode = 88 bytes,
 *   packed(8): InnerNode 88 = tag(1)+pad(3)+prefix_len(4)+key(16)+
 *   children(8)+child_earliest_expiry(16)+reserved(40); LeafNode 88 =
 *   tag(1)+side(1)+tif(1)+pad(1)+owner(4)+key(16)+quantity(8)+
 *   expires_at(8)+peg_limit(8)+client_order_id(8)+price_or_offset(8)+
 *   sequence(8)+flags(1)+reserved(15)).
 */

import { MARKET_DISCRIMINATOR, MARKET_VERSION, MarketMode } from "./market-state";

export const DEFAULT_MAX_MARK_DEVIATION_BPS = 500;

export const MARK_SOURCE = { Index: 0, BookMid: 1, BookOneSided: 2 } as const;
export type MarkSource = (typeof MARK_SOURCE)[keyof typeof MARK_SOURCE];

export interface MarkQuote {
  price: number;
  source: MarkSource;
}

export const BID_ARENA_OFFSET = 512;
export const ASK_ARENA_OFFSET = BID_ARENA_OFFSET + 90_640;
const ARENA_ROOTS_OFFSET = 4;
const ARENA_NODES_OFFSET = 528;
const ANY_NODE_SIZE = 88;
const TAG_INNER = 1;
const TAG_LEAF = 2;
const NONE = 0xffffffff;

// Reserved-region absolute offsets (reserved_upgrade base = 327).
const RESERVED_CLUSTER_MEMBER_COUNT = 327 + 155;
const RESERVED_MAX_MARK_DEVIATION_BPS = 327 + 156; // ..158, i16 LE

const HEADER_ORACLE_VALID = 294;
const HEADER_ORACLE_PRICE = 295;
const HEADER_ORACLE_TIMESTAMP = 303;
const HEADER_MODE = 11;

function readU32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function readI64(bytes: Uint8Array, offset: number): number {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  const signBit = 1n << 63n;
  return Number(value >= signBit ? value - (signBit << 1n) : value);
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

function maxMarkDeviationBps(bytes: Uint8Array): number {
  const raw = bytes[RESERVED_MAX_MARK_DEVIATION_BPS] | (bytes[RESERVED_MAX_MARK_DEVIATION_BPS + 1] << 8);
  const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
  return signed <= 0 ? DEFAULT_MAX_MARK_DEVIATION_BPS : signed;
}

/** Best (leftmost) leaf of one tree, or `null` when the tree is empty or
 * malformed (corrupt arenas never yield a mark; they degrade to the other
 * side or the index). */
function bestLeaf(
  bytes: Uint8Array,
  arenaOffset: number,
  treeIndex: number,
): { side: number; quantity: number; expiresAt: bigint; pegLimit: number; priceOrOffset: number; treeIndex: number } | null {
  const nodes = arenaOffset + ARENA_NODES_OFFSET;
  let handle = readU32(bytes, arenaOffset + ARENA_ROOTS_OFFSET + treeIndex * 4);
  let depth = 0;
  while (handle !== NONE && depth < 2048) {
    depth += 1;
    const nodeBase = nodes + handle * ANY_NODE_SIZE;
    const tag = bytes[nodeBase];
    if (tag === TAG_LEAF) {
      return {
        side: bytes[nodeBase + 1],
        quantity: Number(readU64(bytes, nodeBase + 24)),
        expiresAt: readU64(bytes, nodeBase + 32),
        pegLimit: readI64(bytes, nodeBase + 40),
        priceOrOffset: readI64(bytes, nodeBase + 56),
        treeIndex,
      };
    }
    if (tag === TAG_INNER) {
      handle = readU32(bytes, nodeBase + 24);
      continue;
    }
    return null;
  }
  return null;
}

/** The better executable price on one side across both arenas and both
 * trees. Mirrors `mark::best_executable_price`. */
function bestExecutableSide(bytes: Uint8Array, sideBid: boolean, oracle: number, now: bigint): number | null {
  let best: number | null = null;
  for (const arenaOffset of [BID_ARENA_OFFSET, ASK_ARENA_OFFSET]) {
    for (const treeIndex of [0, 1] as const) {
      const leaf = bestLeaf(bytes, arenaOffset, treeIndex);
      if (!leaf) continue;
      if (leaf.quantity === 0 || leaf.expiresAt <= now) continue;
      if ((leaf.side === 0) !== sideBid) continue;
      let price: number | null;
      if (treeIndex === 0) {
        price = leaf.priceOrOffset;
      } else {
        // Pegged evaluation, exactly `book::pegged_state`: price =
        // oracle + offset; bids require price <= peg_limit, asks
        // price >= peg_limit; peg_limit <= 0 is invalid.
        const priceBig = oracle + leaf.priceOrOffset;
        if (leaf.pegLimit <= 0) price = null;
        else {
          const permitted = sideBid ? priceBig <= leaf.pegLimit : priceBig >= leaf.pegLimit;
          price = permitted ? priceBig : null;
        }
      }
      if (price === null || price <= 0) continue;
      best = best === null ? price : sideBid ? Math.max(best, price) : Math.min(best, price);
    }
  }
  return best;
}

function clampToIndex(mark: number, index: number, maxDeviationBps: number): number {
  const deviation = Math.floor((index * maxDeviationBps) / 10_000);
  const lower = Math.max(1, index - deviation);
  const upper = index + deviation;
  return Math.min(Math.max(mark, lower), upper);
}

/**
 * Computes the mark from raw market-account bytes (the SAME bytes the
 * program would see). Returns `null` when no mark exists: invalid header,
 * wrong version, stale/halted oracle, or a paused market. `Index` quotes
 * still require a verified oracle -- an unverified oracle is never a price.
 */
export function executableMark(bytes: Uint8Array): MarkQuote | null {
  if (bytes.length < 512) return null;
  const discriminator = new TextDecoder().decode(bytes.slice(0, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (discriminator !== MARKET_DISCRIMINATOR || view.getUint16(8, true) !== MARKET_VERSION) return null;
  if (view.getUint8(10) !== 1) return null;
  const mode = bytes[HEADER_MODE];
  if (mode !== MarketMode.Open && mode !== MarketMode.CloseOnly && mode !== MarketMode.Emergency) return null;
  if (bytes[HEADER_ORACLE_VALID] !== 1) return null;
  const index = readI64(bytes, HEADER_ORACLE_PRICE);
  if (index <= 0) return null;
  const now = readU64(bytes, HEADER_ORACLE_TIMESTAMP);
  const maxDeviation = maxMarkDeviationBps(bytes);

  const bestBid = bestExecutableSide(bytes, true, index, now);
  const bestAsk = bestExecutableSide(bytes, false, index, now);
  if (bestBid === null && bestAsk === null) {
    return { price: index, source: MARK_SOURCE.Index };
  }
  if (bestBid !== null && bestAsk !== null) {
    if (bestAsk > bestBid) {
      // floor((bid + ask) / 2), the deterministic round-half-down rule.
      const mid = Math.floor((bestBid + bestAsk) / 2);
      return { price: clampToIndex(mid, index, maxDeviation), source: MARK_SOURCE.BookMid };
    }
    // Crossed/locked: deterministic safe fallback.
    return { price: index, source: MARK_SOURCE.Index };
  }
  const single = (bestBid ?? bestAsk)!;
  return { price: clampToIndex(single, index, maxDeviation), source: MARK_SOURCE.BookOneSided };
}
