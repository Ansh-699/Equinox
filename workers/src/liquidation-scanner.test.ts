import { describe, expect, it } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { SolanaL1Transport } from "./chain-transports";
import { dedupeCandidates, reReadLiquidationCandidate, type LiquidationProjectionCandidate } from "./liquidation-scanner";

const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;
const MARKET_ACCOUNT_SIZE = 512 + 90_640 + 90_640 + 128 * 256 + 64 * 128;

function seatFieldOffsets() {
  return { occupancy: 0, trader: 1, availableCollateral: 40, reservedMargin: 56, basePosition: 72, quoteEntryValue: 88, realizedPnl: 104, lastFundingAccumulator: 120, openBidExposure: 136, openAskExposure: 152, openOrderCount: 168, liquidationState: 172, sequence: 176 };
}

function writeI128(bytes: Uint8Array, offset: number, value: bigint) {
  let v = value < 0n ? (1n << 128n) + value : value;
  for (let i = 0; i < 16; i += 1) { bytes[offset + i] = Number(v & 0xffn); v >>= 8n; }
}

function accountFixture(opts: {
  mode?: number;
  oracleValid?: boolean;
  markPrice?: bigint;
  maintenanceBps?: number;
  seatIndex: number;
  occupied?: boolean;
  sequence?: bigint;
  availableCollateral?: bigint;
  basePosition?: bigint;
  quoteEntryValue?: bigint;
}): Uint8Array {
  const bytes = new Uint8Array(MARKET_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("STKMRK01"), 0);
  view.setUint16(8, 2, true);
  view.setUint8(10, 1);
  view.setUint8(11, opts.mode ?? 1);
  bytes.set(getBase58Encoder().encode("SysvarRent111111111111111111111111111111111"), 12);
  bytes.set(getBase58Encoder().encode("SysvarC1ock11111111111111111111111111111111"), 76);
  view.setUint16(194, opts.maintenanceBps ?? 1_000, true);
  view.setUint8(294, opts.oracleValid === false ? 0 : 1);
  view.setBigInt64(295, opts.markPrice ?? 100_000n, true);
  view.setBigUint64(303, 1_700_000_000n, true);

  const seatOffsets = seatFieldOffsets();
  const start = TRADER_SEAT_OFFSET + opts.seatIndex * TRADER_SEAT_SIZE;
  bytes[start + seatOffsets.occupancy] = opts.occupied === false ? 0 : 1;
  writeI128(bytes, start + seatOffsets.availableCollateral, opts.availableCollateral ?? 1_000n);
  writeI128(bytes, start + seatOffsets.basePosition, opts.basePosition ?? 10n);
  writeI128(bytes, start + seatOffsets.quoteEntryValue, opts.quoteEntryValue ?? 1_000n);
  new DataView(bytes.buffer).setBigUint64(start + seatOffsets.sequence, opts.sequence ?? 1n, true);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

function transportServing(bytes: Uint8Array): SolanaL1Transport {
  const base64 = bytesToBase64(bytes);
  const fetcher = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ data: [base64, "base64"], owner: "x", lamports: 1 }] } }), { status: 200 });
  return new SolanaL1Transport("https://l1.test", fetcher as typeof fetch);
}

describe("reReadLiquidationCandidate", () => {
  const marketPda = "Market1111111111111111111111111111111111111";
  const baseCandidate: LiquidationProjectionCandidate = { seatIndex: 0, projectedSequence: 1n };

  it("projection says unhealthy but onchain is actually healthy -> not liquidated", async () => {
    // Mark 100, position 10, entry 1000, collateral 1000 -> equity 1000 >= 10% of 1000 notional (100).
    const transport = transportServing(accountFixture({ seatIndex: 0, markPrice: 100n, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 1_000n }));
    const outcome = await reReadLiquidationCandidate(transport, marketPda, baseCandidate);
    expect(outcome.status).toBe("healthy");
  });

  it("is actually unhealthy -> liquidatable with a positive quantity", async () => {
    const transport = transportServing(accountFixture({ seatIndex: 0, markPrice: 10n, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 5n }));
    const outcome = await reReadLiquidationCandidate(transport, marketPda, baseCandidate);
    expect(outcome.status).toBe("liquidatable");
    if (outcome.status === "liquidatable") expect(outcome.result.quantity).toBeGreaterThan(0n);
  });

  it("a stale projection (sequence has moved on) is rejected as already-progressed", async () => {
    const transport = transportServing(accountFixture({ seatIndex: 0, sequence: 5n }));
    const outcome = await reReadLiquidationCandidate(transport, marketPda, { seatIndex: 0, projectedSequence: 1n });
    expect(outcome.status).toBe("already-progressed");
  });

  it("position already liquidated / seat now empty is rejected as not-found", async () => {
    const transport = transportServing(accountFixture({ seatIndex: 0, occupied: false }));
    const outcome = await reReadLiquidationCandidate(transport, marketPda, baseCandidate);
    expect(outcome.status).toBe("not-found");
  });

  it("refuses to act on a stale oracle", async () => {
    const transport = transportServing(accountFixture({ seatIndex: 0, oracleValid: false }));
    const outcome = await reReadLiquidationCandidate(transport, marketPda, baseCandidate);
    expect(outcome.status).toBe("stale-oracle");
  });

  it("refuses to act while the market is in Emergency halt", async () => {
    const transport = transportServing(accountFixture({ seatIndex: 0, mode: 3 }));
    const outcome = await reReadLiquidationCandidate(transport, marketPda, baseCandidate);
    expect(outcome.status).toBe("market-halted");
  });
});

describe("dedupeCandidates", () => {
  it("keeps one entry per seat index", () => {
    const candidates: LiquidationProjectionCandidate[] = [
      { seatIndex: 1, projectedSequence: 1n },
      { seatIndex: 2, projectedSequence: 1n },
      { seatIndex: 1, projectedSequence: 2n },
    ];
    const deduped = dedupeCandidates(candidates);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((c) => c.seatIndex === 1)?.projectedSequence).toBe(2n);
  });
});
