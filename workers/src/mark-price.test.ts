/**
 * Rust/TypeScript risk parity: `workers/src/mark-price.ts` must produce the
 * exact same mark the on-chain `mark::executable_mark` computes for the
 * same market-account bytes. The fixture market-account bytes are built in
 * the same shape the Rust `tests/mark_price.rs` vectors use; the expected
 * values below are transcribed from those Rust tests (same test names, one
 * parity vector per Rust test).
 */

import { expect, test } from "vitest";
import { executableMark, MARK_SOURCE, BID_ARENA_OFFSET, ASK_ARENA_OFFSET } from "./mark-price";

const MARKET_ACCOUNT_SIZE = 512 + 90_640 + 90_640 + 128 * 256 + 64 * 128;

function marketBytes(): Uint8Array {
  // A real arena's empty roots are `NONE` (u32::MAX), not zero -- matches
  // `book::Arena::new()`; a zero root would be a valid node handle.
  const bytes = new Uint8Array(MARKET_ACCOUNT_SIZE);
  for (const arenaOffset of [BID_ARENA_OFFSET, ASK_ARENA_OFFSET]) {
    const view = new DataView(bytes.buffer, arenaOffset, 12);
    view.setUint32(4, 0xffffffff, true);
    view.setUint32(8, 0xffffffff, true);
  }
  return bytes;
}

function stampHeader(bytes: Uint8Array, oraclePrice: number, oracleValid: number, mode: number, timestamp = 1_700_000): void {
  new TextEncoder().encodeInto("STKMRK01", bytes.subarray(0, 8));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 2, true); // MARKET_VERSION
  bytes[10] = 1; // initialized
  bytes[11] = mode;
  view.setUint8(294, oracleValid);
  view.setBigInt64(295, BigInt(oraclePrice), true);
  view.setBigUint64(303, BigInt(timestamp), true);
  view.setUint32(311, 512, true); // bid_arena_offset
  view.setUint32(315, 91_152, true); // ask_arena_offset
  view.setUint32(319, 181_792, true); // trader_seat_offset
  view.setUint32(323, 214_560, true); // fill_event_offset
}

const LEAF = 2;
const INNER = 1;

/** Writes a leaf node into an arena's node region. */
function writeLeaf(
  bytes: Uint8Array,
  arenaOffset: number,
  handle: number,
  leaf: { side: number; quantity: number; priceOrOffset: number; expiresAt?: number; pegLimit?: number; treeKind: "fixed" | "pegged" },
): void {
  const nodes = arenaOffset + 528;
  const base = nodes + handle * 88;
  bytes[nodeBase(0)] = 0; // overwritten below; tag written last
  bytes[nodeBase(0)] = LEAF;
  bytes[nodeBase(1)] = leaf.side;
  bytes[nodeBase(4)] = 0; // owner bits are irrelevant to the mark
  const view = new DataView(bytes.buffer);
  view.setBigUint64(nodeBase(24), BigInt(leaf.quantity), true);
  view.setBigUint64(nodeBase(32), BigInt(leaf.expiresAt ?? 170000000), true);
  view.setBigInt64(nodeBase(40), BigInt(leaf.pegLimit ?? (leaf.side === 0 ? Number.MAX_SAFE_INTEGER : 1)), true);
  view.setBigInt64(nodeBase(56), BigInt(leaf.priceOrOffset), true);
  void leaf.treeKind;
  function nodeBase(offset: number): number {
    return nodes + handle * 88 + offset;
  }
}

/** Wires a minimal single-leaf tree: inner root -> leaf. */
function plantTree(
  bytes: Uint8Array,
  arenaOffset: number,
  treeIndex: number,
  leafHandle: number,
  innerHandle: number,
): void {
  const nodes = arenaOffset + 528;
  const innerBase = nodes + innerHandle * 88;
  bytes[innerBase] = INNER;
  const view = new DataView(bytes.buffer);
  view.setUint32(innerBase + 4, 64, true); // prefix_len
  // key = any
  view.setUint32(innerBase + 24, leafHandle, true); // children[0]
  view.setUint32(innerBase + 28, 0xffffffff, true); // children[1]
  view.setUint32(arenaOffset + 4 + treeIndex * 4, innerHandle, true); // root
}

function leafNodeHandle(index: number): number {
  return index;
}

test("parity: two-sided fixed book marks the floor mid (Rust: 100)", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  plantTree(bytes, BID_ARENA_OFFSET, 0, leafNodeHandle(0), 1);
  plantTree(bytes, ASK_ARENA_OFFSET, 0, leafNodeHandle(2), 3);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 99, treeKind: "fixed" });
  writeLeaf(bytes, ASK_ARENA_OFFSET, 2, { side: 1, quantity: 10, priceOrOffset: 101, treeKind: "fixed" });
  const quote = executableMark(bytes);
  expect(quote).toEqual({ price: 100, source: MARK_SOURCE.BookMid });
});

test("parity: one-sided bid clamps to the deviation band (105)", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  plantTree(bytes, BID_ARENA_OFFSET, 0, leafNodeHandle(0), 1);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 120, treeKind: "fixed" });
  const quote = executableMark(bytes);
  expect(quote).toEqual({ price: 105, source: MARK_SOURCE.BookOneSided });
});

test("parity: empty book falls back to the verified index", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  expect(executableMark(bytes)).toEqual({ price: 100, source: MARK_SOURCE.Index });
});

test("parity: crossed book falls back to the index", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  plantTree(bytes, BID_ARENA_OFFSET, 0, leafNodeHandle(0), 1);
  plantTree(bytes, ASK_ARENA_OFFSET, 0, leafNodeHandle(2), 3);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 110, treeKind: "fixed" });
  writeLeaf(bytes, ASK_ARENA_OFFSET, 2, { side: 1, quantity: 10, priceOrOffset: 101, treeKind: "fixed" });
  const quote = executableMark(bytes);
  expect(quote).toEqual({ price: 100, source: MARK_SOURCE.Index });
});

test("parity: invalid pegged bid excluded; ask one-sided", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  // Pegged bid with peg_limit 100 evaluated at 110 -> invalid.
  plantTree(bytes, BID_ARENA_OFFSET, 1, leafNodeHandle(0), 1);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 10, pegLimit: 100, treeKind: "pegged" });
  plantTree(bytes, ASK_ARENA_OFFSET, 0, leafNodeHandle(2), 3);
  writeLeaf(bytes, ASK_ARENA_OFFSET, 2, { side: 1, quantity: 10, priceOrOffset: 101, treeKind: "fixed" });
  const quote = executableMark(bytes);
  expect(quote).toEqual({ price: 101, source: MARK_SOURCE.BookOneSided });
});

test("parity: expired order excluded", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  plantTree(bytes, BID_ARENA_OFFSET, 0, leafNodeHandle(0), 1);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 99, expiresAt: 10, treeKind: "fixed" });
  plantTree(bytes, ASK_ARENA_OFFSET, 0, leafNodeHandle(2), 3);
  writeLeaf(bytes, ASK_ARENA_OFFSET, 2, { side: 1, quantity: 10, priceOrOffset: 101, treeKind: "fixed" });
  const quote = executableMark(bytes);
  expect(quote).toEqual({ price: 101, source: MARK_SOURCE.BookOneSided });
});

test("parity: stale/halted oracle yields no mark", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 0, 1);
  expect(executableMark(bytes)).toBeNull();
  const halted = marketBytes();
  stampHeader(halted, 100, 1, 0);
  expect(executableMark(halted)).toBeNull();
});

test("parity: strict deviation override applies", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  bytes[327 + 156] = 50; // i16 LE 50 = 0.5%
  bytes[327 + 157] = 0;
  plantTree(bytes, BID_ARENA_OFFSET, 0, leafNodeHandle(0), 1);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 120, treeKind: "fixed" });
  const quote = executableMark(bytes);
  expect(quote).toEqual({ price: 100, source: MARK_SOURCE.BookOneSided });
});

test("reserved_upgrade region: cluster count byte and deviation field coexist", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  bytes[327 + 155] = 4; // cluster member count
  expect(executableMark(bytes)).toEqual({ price: 100, source: MARK_SOURCE.Index });
  expect(bytes[RESERVED_READ(bytes)]).toBe(4);
  function RESERVED_READ(b: Uint8Array): number {
    return 327 + 155;
  }
});

test("negative basis marks below the index (unclamped)", () => {
  const bytes = marketBytes();
  stampHeader(bytes, 100, 1, 1);
  plantTree(bytes, BID_ARENA_OFFSET, 0, leafNodeHandle(0), 1);
  plantTree(bytes, ASK_ARENA_OFFSET, 0, leafNodeHandle(2), 3);
  writeLeaf(bytes, BID_ARENA_OFFSET, 0, { side: 0, quantity: 10, priceOrOffset: 96, treeKind: "fixed" });
  writeLeaf(bytes, ASK_ARENA_OFFSET, 2, { side: 1, quantity: 10, priceOrOffset: 98, treeKind: "fixed" });
  expect(executableMark(bytes)).toEqual({ price: 97, source: MARK_SOURCE.BookMid });
});
