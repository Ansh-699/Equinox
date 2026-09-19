import { describe, expect, it } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { aggregateV3Market, decodeV3BookPage, decodeV3Core, decodeV3EventShard, decodeV3SeatShard, V3_BOOK_PAGE_SIZE, V3_CORE_SIZE, V3_EVENT_SHARD_SIZE, V3_SEAT_SHARD_SIZE } from "./v3-market-state";

const decoder = getBase58Decoder();
const coreAddress = decoder.decode(new Uint8Array(32).fill(7));
const write = (bytes: Uint8Array, text: string, at = 0) => bytes.set(new TextEncoder().encode(text), at);
const u16 = (bytes: Uint8Array, at: number, value: number) => new DataView(bytes.buffer).setUint16(at, value, true);

function core(): Uint8Array {
  const bytes = new Uint8Array(V3_CORE_SIZE); write(bytes, "STKMK003"); u16(bytes, 8, 3); bytes[10] = 1; bytes[11] = 1;
  bytes[12] = 1; bytes[44] = 2; bytes[180] = 1; bytes[197] = 3; return bytes;
}
function page(side: number, index: number): Uint8Array {
  const bytes = new Uint8Array(V3_BOOK_PAGE_SIZE); write(bytes, "STKBK003"); u16(bytes, 8, 3); bytes[10] = side; bytes[11] = index; bytes.set(new Uint8Array(32).fill(7), 12); return bytes;
}
function leafPage(side: number, index: number): Uint8Array {
  const bytes = page(side, index); const at = 64; bytes[at] = 2; bytes[at + 1] = side; bytes[at + 4] = 1;
  new DataView(bytes.buffer).setBigUint64(at + 8, BigInt(index + 1), true); new DataView(bytes.buffer).setBigUint64(at + 24, 5n, true); return bytes;
}
function shard(event: boolean, index: number): Uint8Array {
  const bytes = new Uint8Array(event ? V3_EVENT_SHARD_SIZE : V3_SEAT_SHARD_SIZE); write(bytes, event ? "STKEV003" : "STKST003"); u16(bytes, 8, 3); bytes[10] = index; bytes.set(new Uint8Array(32).fill(7), 12); return bytes;
}

describe("V3 worker shard aggregation", () => {
  it("decodes exact core and page ABI offsets", () => {
    expect(decodeV3Core(core())?.delegationStatus).toBe(3);
    expect(decodeV3BookPage(page(1, 3))).toMatchObject({ side: 1, page: 3, core: coreAddress });
    expect(decodeV3Core(new Uint8Array(V3_CORE_SIZE))).toBeNull();
    const globalPage = page(0, 0); new DataView(globalPage.buffer).setUint32(60, 1_024, true);
    expect(decodeV3BookPage(globalPage)?.nodeCount).toBe(1_024);
    const localPage = page(0, 1); new DataView(localPage.buffer).setUint32(60, 257, true);
    expect(decodeV3BookPage(localPage)).toBeNull();
  });
  it("requires every distinct shard before declaring withdrawal ready", () => {
    const books = Array.from({ length: 8 }, (_, value) => page(Math.floor(value / 4), value % 4));
    const seats = Array.from({ length: 4 }, (_, value) => shard(false, value));
    const events = Array.from({ length: 4 }, (_, value) => shard(true, value));
    expect(aggregateV3Market(core(), books, seats, events, coreAddress)).toMatchObject({ completeBook: true, completeExecutionState: true, withdrawalReady: true });
    const aggregate = aggregateV3Market(core(), [leafPage(0, 0), ...books.slice(1)], seats, events, coreAddress)!;
    expect(aggregate.orderBook.bids[0]).toMatchObject({ tag: 2, side: 0, quantity: 5n });
    expect(aggregateV3Market(core(), [...books.slice(0, 7), page(1, 2)], seats, events, coreAddress)).toBeNull();
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
});
