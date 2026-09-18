import { describe, expect, it } from "vitest";
import { decodeTraderSeat, TRADER_SEAT_SIZE } from "./positions";

const TRADER_SEAT_OFFSET = 1_000; // arbitrary for the test; production reads this from MarketStateView.traderSeatOffset

function writeI128LE(bytes: Buffer, offset: number, value: bigint) {
  const unsigned = value < 0n ? value + (1n << 128n) : value;
  for (let i = 0; i < 16; i += 1) bytes[offset + i] = Number((unsigned >> BigInt(8 * i)) & 0xffn);
}

function seatBytes({ occupied = true, liquidationState = 0 } = {}) {
  const bytes = Buffer.alloc(TRADER_SEAT_OFFSET + TRADER_SEAT_SIZE * 2);
  const start = TRADER_SEAT_OFFSET;
  bytes[start + 0] = occupied ? 1 : 0; // occupancy
  Buffer.from(new Uint8Array(32).fill(7)).copy(bytes, start + 1); // trader
  writeI128LE(bytes, start + 40, 500_000n); // availableCollateral
  writeI128LE(bytes, start + 56, 100_000n); // reservedMargin
  writeI128LE(bytes, start + 72, -25n); // basePosition (negative -> short)
  writeI128LE(bytes, start + 88, 2_500_000n); // quoteEntryValue
  writeI128LE(bytes, start + 104, 1_200n); // realizedPnl
  writeI128LE(bytes, start + 120, 300n); // lastFundingAccumulator
  writeI128LE(bytes, start + 136, 10n); // openBidExposure
  writeI128LE(bytes, start + 152, 5n); // openAskExposure
  bytes.writeUInt32LE(3, start + 168); // openOrderCount
  bytes[start + 172] = liquidationState;
  bytes.writeBigUInt64LE(42n, start + 176); // sequence
  return bytes;
}

describe("decodeTraderSeat", () => {
  it("decodes an occupied seat's raw fields exactly, including a negative i128", () => {
    const seat = decodeTraderSeat(seatBytes(), TRADER_SEAT_OFFSET, 0);
    expect(seat).not.toBeNull();
    expect(seat?.owner.length).toBeGreaterThan(30);
    expect(seat?.availableCollateral).toBe(500_000n);
    expect(seat?.basePosition).toBe(-25n);
    expect(seat?.openOrderCount).toBe(3);
    expect(seat?.liquidationState).toBe("healthy");
    expect(seat?.sequence).toBe(42n);
  });
  it("returns null for an unoccupied seat rather than fabricating zeros as a position", () => {
    expect(decodeTraderSeat(seatBytes({ occupied: false }), TRADER_SEAT_OFFSET, 0)).toBeNull();
  });
  it("maps every liquidation-state byte to its label", () => {
    expect(decodeTraderSeat(seatBytes({ liquidationState: 1 }), TRADER_SEAT_OFFSET, 0)?.liquidationState).toBe("warning");
    expect(decodeTraderSeat(seatBytes({ liquidationState: 2 }), TRADER_SEAT_OFFSET, 0)?.liquidationState).toBe("liquidatable");
    expect(decodeTraderSeat(seatBytes({ liquidationState: 3 }), TRADER_SEAT_OFFSET, 0)?.liquidationState).toBe("bankrupt");
    expect(decodeTraderSeat(seatBytes({ liquidationState: 9 }), TRADER_SEAT_OFFSET, 0)?.liquidationState).toBe("unknown");
  });
  it("rejects an out-of-range seat index without reading out of bounds", () => {
    expect(decodeTraderSeat(seatBytes(), TRADER_SEAT_OFFSET, -1)).toBeNull();
    expect(decodeTraderSeat(seatBytes(), TRADER_SEAT_OFFSET, 128)).toBeNull();
  });
  it("returns null when the account is too short to contain the seat", () => {
    expect(decodeTraderSeat(seatBytes().subarray(0, TRADER_SEAT_OFFSET + 10), TRADER_SEAT_OFFSET, 0)).toBeNull();
  });
  it("reads the second seat slot at the correct stride", () => {
    const bytes = seatBytes();
    const seat = decodeTraderSeat(bytes, TRADER_SEAT_OFFSET, 1);
    // Slot 1 was never written -> occupancy byte is 0 -> unoccupied.
    expect(seat).toBeNull();
  });
});
