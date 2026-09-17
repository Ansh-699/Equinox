import { describe, expect, it } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { decodeMarketHeader } from "./market-state";
import { scanLiquidationCandidates } from "./liquidation-discovery";

const MARKET_ACCOUNT_SIZE = 512 + 90_640 + 90_640 + 128 * 256 + 64 * 128;
const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;

function writeI128(bytes: Uint8Array, offset: number, value: bigint) {
  let v = value < 0n ? (1n << 128n) + value : value;
  for (let i = 0; i < 16; i += 1) { bytes[offset + i] = Number(v & 0xffn); v >>= 8n; }
}

function accountFixture(seats: Array<{ index: number; occupied: boolean; basePosition: bigint; quoteEntryValue: bigint; availableCollateral: bigint }>): Uint8Array {
  const bytes = new Uint8Array(MARKET_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("STKMRK01"), 0);
  view.setUint16(8, 2, true);
  view.setUint8(10, 1);
  view.setUint8(11, 1);
  bytes.set(getBase58Encoder().encode("SysvarRent111111111111111111111111111111111"), 12);
  bytes.set(getBase58Encoder().encode("SysvarC1ock11111111111111111111111111111111"), 76);
  view.setUint16(194, 1_000, true);
  view.setUint8(294, 1);
  view.setBigInt64(295, 10n, true); // mark price crashed to 10 so leveraged seats are unhealthy
  view.setBigUint64(303, 1_700_000_000n, true);
  for (const seat of seats) {
    const start = TRADER_SEAT_OFFSET + seat.index * TRADER_SEAT_SIZE;
    bytes[start + 0] = seat.occupied ? 1 : 0;
    writeI128(bytes, start + 40, seat.availableCollateral);
    writeI128(bytes, start + 72, seat.basePosition);
    writeI128(bytes, start + 88, seat.quoteEntryValue);
    new DataView(bytes.buffer).setBigUint64(start + 176, 1n, true);
  }
  return bytes;
}

describe("scanLiquidationCandidates", () => {
  it("finds only occupied, actually-unhealthy seats within the batch window", () => {
    const bytes = accountFixture([
      { index: 0, occupied: true, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 5n }, // unhealthy
      { index: 1, occupied: true, basePosition: 0n, quoteEntryValue: 0n, availableCollateral: 1_000n }, // flat, healthy
      { index: 2, occupied: false, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 5n }, // unoccupied, skipped
    ]);
    const header = decodeMarketHeader(bytes)!;
    const result = scanLiquidationCandidates(bytes, header, 0, 32);
    expect(result.candidates.map((c) => c.seatIndex)).toEqual([0]);
  });

  it("bounds the scan to the requested batch size and advances the cursor", () => {
    const bytes = accountFixture([{ index: 0, occupied: true, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 5n }]);
    const header = decodeMarketHeader(bytes)!;
    const result = scanLiquidationCandidates(bytes, header, 1, 4);
    expect(result.candidates).toHaveLength(0); // seat 0 is outside [1, 5)
    expect(result.nextCursor).toBe(5);
  });

  it("wraps the cursor around the seat count", () => {
    const bytes = accountFixture([]);
    const header = decodeMarketHeader(bytes)!;
    const result = scanLiquidationCandidates(bytes, header, 126, 4);
    expect(result.nextCursor).toBe(2); // (126+4) % 128
  });

  it("finds nothing when the oracle is invalid", () => {
    const bytes = accountFixture([{ index: 0, occupied: true, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 5n }]);
    new DataView(bytes.buffer).setUint8(294, 0);
    const header = decodeMarketHeader(bytes)!;
    const result = scanLiquidationCandidates(bytes, header, 0, 32);
    expect(result.candidates).toHaveLength(0);
  });
});
