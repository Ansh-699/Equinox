import { describe, expect, it } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { aggregateV3Market, decodeV3BookPage, decodeV3Core, decodeV3EventShard, decodeV3SeatShard, executableV3Mark, fetchAuthoritativeV3Market, V3_BOOK_PAGE_SIZE, V3_BOOK_PAGES_PER_SIDE, V3_CORE_SIZE, V3_EVENT_SHARD_SIZE, V3_SEAT_SHARD_SIZE } from "./v3-market-state";

const decoder = getBase58Decoder();
const coreAddress = decoder.decode(new Uint8Array(32).fill(7));
const write = (bytes: Uint8Array, text: string, at = 0) => bytes.set(new TextEncoder().encode(text), at);
const u16 = (bytes: Uint8Array, at: number, value: number) => new DataView(bytes.buffer).setUint16(at, value, true);

function core(): Uint8Array {
  const bytes = new Uint8Array(V3_CORE_SIZE); write(bytes, "STKMK003"); u16(bytes, 8, 3); bytes[10] = 1; bytes[11] = 1; bytes[371] = 2;
  bytes[12] = 1; bytes[44] = 2; bytes[180] = 1; bytes[197] = 3; new DataView(bytes.buffer).setUint32(246, 922, true); bytes[250] = 1; new DataView(bytes.buffer).setInt32(251, -6, true); return bytes;
}
function page(side: number, index: number): Uint8Array {
  const bytes = new Uint8Array(V3_BOOK_PAGE_SIZE); write(bytes, "STKBK003"); u16(bytes, 8, 3); bytes[10] = side; bytes[11] = index; bytes.set(new Uint8Array(32).fill(7), 12);
  if (index === 0) { new DataView(bytes.buffer).setUint32(44, 0xffff_ffff, true); new DataView(bytes.buffer).setUint32(48, 0xffff_ffff, true); }
  return bytes;
}
function leafPage(side: number, index: number): Uint8Array {
  const bytes = page(side, index); const at = 64; bytes[at] = 2; bytes[at + 1] = side; bytes[at + 4] = 1;
  new DataView(bytes.buffer).setBigUint64(at + 8, BigInt(index + 1), true); new DataView(bytes.buffer).setBigUint64(at + 24, 5n, true); return bytes;
}
function shard(event: boolean, index: number): Uint8Array {
  const bytes = new Uint8Array(event ? V3_EVENT_SHARD_SIZE : V3_SEAT_SHARD_SIZE); write(bytes, event ? "STKEV003" : "STKST003"); u16(bytes, 8, 3); bytes[10] = index; bytes.set(new Uint8Array(32).fill(7), 12); return bytes;
}

describe("V3 worker shard aggregation", () => {
  it("rejects a correctly-shaped shard owned by a foreign program", async () => {
    const bytes = [core(), ...Array.from({ length: 18 }, (_, value) => page(Math.floor(value / 9), value % 9)), ...Array.from({ length: 4 }, (_, value) => shard(false, value)), ...Array.from({ length: 4 }, (_, value) => shard(true, value))];
    const transport = { multipleAccounts: async () => ({ context: { slot: 1 }, value: bytes.map((data, index) => ({ data: [btoa(String.fromCharCode(...data)), "base64"] as [string, string], owner: index === 0 ? "foreign-program" : "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ", lamports: 1 })) }) } as never;
    expect(await fetchAuthoritativeV3Market(transport, { core: coreAddress, bookPages: Array.from({ length: 18 }, (_, i) => `page-${i}`), seatShards: Array.from({ length: 4 }, (_, i) => `seat-${i}`), eventShards: Array.from({ length: 4 }, (_, i) => `event-${i}`) })).toBeNull();
  });

  it("decodes exact core and page ABI offsets", () => {
    expect(decodeV3Core(core())).toMatchObject({ delegationStatus: 3, oracleFeedId: 922, oracleChannel: 1, oracleExponent: -6 });
    expect(decodeV3BookPage(page(1, 3))).toMatchObject({ side: 1, page: 3, core: coreAddress });
    expect(decodeV3Core(new Uint8Array(V3_CORE_SIZE))).toBeNull();
    const globalPage = page(0, 0); new DataView(globalPage.buffer).setUint32(60, 1_024, true);
    expect(decodeV3BookPage(globalPage)?.nodeCount).toBe(1_024);
    const localPage = page(0, 1); new DataView(localPage.buffer).setUint32(60, 257, true);
    expect(decodeV3BookPage(localPage)).toBeNull();
  });
  it("requires every distinct shard before declaring withdrawal ready", () => {
    const books = Array.from({ length: 2 * V3_BOOK_PAGES_PER_SIDE }, (_, value) => page(Math.floor(value / V3_BOOK_PAGES_PER_SIDE), value % V3_BOOK_PAGES_PER_SIDE));
    const seats = Array.from({ length: 4 }, (_, value) => shard(false, value));
    const events = Array.from({ length: 4 }, (_, value) => shard(true, value));
    expect(aggregateV3Market(core(), books, seats, events, coreAddress, 42)).toMatchObject({ asOfSlot: 42, completeBook: true, completeExecutionState: true, withdrawalReady: true });
    const aggregate = aggregateV3Market(core(), [leafPage(0, 0), ...books.slice(1)], seats, events, coreAddress)!;
    expect(aggregate.orderBook.bids[0]).toMatchObject({ tag: 2, side: 0, quantity: 5n });
    expect(aggregateV3Market(core(), [...books.slice(0, books.length - 1), page(1, 2)], seats, events, coreAddress)).toBeNull();
  });

  it("retains V3 leaf fields and attributes leaves to their Patricia tree", () => {
    const bytes = leafPage(0, 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(44, 0, true); // fixed root -> global handle zero
    view.setBigInt64(64 + 56, 101n, true);
    view.setBigUint64(64 + 64, 9n, true);
    bytes[64 + 72] = 3; // post-only + reduce-only
    const decoded = decodeV3BookPage(bytes)!;
    expect(decoded.nodes[0]).toMatchObject({ priceOrOffset: 101n, sequence: 9n, postOnly: true, reduceOnly: true });
    const books = [bytes, ...Array.from({ length: 2 * V3_BOOK_PAGES_PER_SIDE - 1 }, (_, value) => page(Math.floor((value + 1) / V3_BOOK_PAGES_PER_SIDE), (value + 1) % V3_BOOK_PAGES_PER_SIDE))];
    const seats = Array.from({ length: 4 }, (_, value) => shard(false, value));
    const events = Array.from({ length: 4 }, (_, value) => shard(true, value));
    expect(aggregateV3Market(core(), books, seats, events, coreAddress)?.orderBook.bids[0]).toMatchObject({ tree: "fixed" });
  });

  it("does not attribute an ambiguous shared non-empty root", () => {
    const bytes = leafPage(0, 0); const view = new DataView(bytes.buffer);
    view.setUint32(44, 0, true); view.setUint32(48, 0, true);
    const books = [bytes, ...Array.from({ length: 2 * V3_BOOK_PAGES_PER_SIDE - 1 }, (_, value) => page(Math.floor((value + 1) / V3_BOOK_PAGES_PER_SIDE), (value + 1) % V3_BOOK_PAGES_PER_SIDE))];
    const seats = Array.from({ length: 4 }, (_, value) => shard(false, value));
    const events = Array.from({ length: 4 }, (_, value) => shard(true, value));
    expect(aggregateV3Market(core(), books, seats, events, coreAddress)?.orderBook.bids[0].tree).toBeUndefined();
  });
  it("rejects missing and cyclic Patricia children instead of exposing partial leaves", () => {
    const malformed = leafPage(0, 0); const view = new DataView(malformed.buffer);
    malformed[64] = 1; // inner root
    view.setUint32(44, 0, true); // fixed root -> handle zero
    view.setUint32(60, 1, true); // one occupied node
    view.setUint32(64 + 24, 1, true); // child handle is absent
    view.setUint32(64 + 28, 0xffff_ffff, true);
    const books = [malformed, ...Array.from({ length: 2 * V3_BOOK_PAGES_PER_SIDE - 1 }, (_, value) => page(Math.floor((value + 1) / V3_BOOK_PAGES_PER_SIDE), (value + 1) % V3_BOOK_PAGES_PER_SIDE))];
    const seats = Array.from({ length: 4 }, (_, value) => shard(false, value));
    const events = Array.from({ length: 4 }, (_, value) => shard(true, value));
    expect(aggregateV3Market(core(), books, seats, events, coreAddress)).toBeNull();
    view.setUint32(64 + 24, 0, true); // self-cycle
    expect(aggregateV3Market(core(), books, seats, events, coreAddress)).toBeNull();
  });
  it("decodes complete persisted event records", () => {
    const bytes = shard(true, 0);
    bytes[44] = 200; bytes[45] = 0;
    new DataView(bytes.buffer).setBigUint64(48, 32n, true);
    new DataView(bytes.buffer).setBigUint64(88, 77n, true);
    bytes.fill(9, 96, 144);
    expect(decodeV3EventShard(bytes)?.records[0]).toMatchObject({ kind: 200, sequence: 32n, timestamp: 77n });
  });
  it("decodes occupied V3 seat positions with Rust ABI offsets", () => {
    const bytes = shard(false, 2); const base = 44; bytes[base] = 1; bytes.fill(8, base + 1, base + 33);
    const view = new DataView(bytes.buffer); view.setBigUint64(base + 72, 5n, true); view.setUint32(base + 168, 2, true);
    expect(decodeV3SeatShard(bytes)?.positions[0]).toMatchObject({ shard: 2, slot: 0, basePosition: 5n, openOrderCount: 2 });
  });
  it("computes an executable mark from paged V3 Patricia leaves, not V2 offsets", () => {
    const coreBytes = core(); const coreView = new DataView(coreBytes.buffer); coreView.setBigInt64(181, 100n, true); coreView.setBigUint64(189, 50n, true);
    const bid = leafPage(0, 0); const ask = leafPage(1, 0); const bidView = new DataView(bid.buffer); const askView = new DataView(ask.buffer);
    bidView.setUint32(44, 0, true); askView.setUint32(44, 0, true); bidView.setBigInt64(64 + 56, 99n, true); askView.setBigInt64(64 + 56, 101n, true); bidView.setBigUint64(64 + 32, 100n, true); askView.setBigUint64(64 + 32, 100n, true);
    const books = [bid, ...Array.from({ length: V3_BOOK_PAGES_PER_SIDE - 1 }, (_, value) => page(0, value + 1)), ask, ...Array.from({ length: V3_BOOK_PAGES_PER_SIDE - 1 }, (_, value) => page(1, value + 1))];
    const seats = Array.from({ length: 4 }, (_, value) => shard(false, value)); const events = Array.from({ length: 4 }, (_, value) => shard(true, value));
    const aggregate = aggregateV3Market(coreBytes, books, seats, events, coreAddress)!;
    expect(executableV3Mark(aggregate, 50n)).toEqual({ price: 100, source: 1 });
    expect(executableV3Mark(aggregate, 101n)).toEqual({ price: 100, source: 0 });
  });
});
