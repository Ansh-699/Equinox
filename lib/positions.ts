/**
 * Frontend-owned TraderSeat decoder. Trader seats are not their own
 * accounts -- they live embedded in the market account at
 * `MarketStateView.traderSeatOffset + seatIndex * TRADER_SEAT_SIZE`
 * (`programs/equinox/src::TraderSeat`, `#[repr(C, packed(8))]`).
 *
 * These field offsets are not re-derived here: they are ported verbatim
 * from `workers/src/private-sessions.ts::SEAT_FIELD_OFFSETS`, which
 * documents them as verified against the Rust struct via
 * `core::mem::offset_of!` (see docs/program-layout.md) -- hand-summing
 * field sizes gives wrong values once an `i128` field forces 8-byte
 * alignment padding. This module reads directly off `SolanaRpcTransport
 * .market()`'s already-fetched account bytes rather than adding a new RPC
 * round-trip.
 *
 * Deliberately NOT computed here: equity and unrealized PnL. Those need
 * the current oracle mark price and the exact formula in
 * `programs/equinox/src/risk.rs::equity`/`unrealized_pnl`; duplicating
 * that math in the frontend without shared parity vectors would be
 * exactly the "authoritative risk calculation hidden in a UI component"
 * the frontend spec forbids. Only raw, directly-read account fields are
 * exposed. The on-chain program remains the sole source of margin/health
 * truth; this is a display-only reflection of what it already committed.
 */

export const TRADER_SEAT_SIZE = 256;
export const MAX_TRADER_SEATS = 128;

const SEAT_FIELD_OFFSETS = {
  occupancy: 0,
  trader: 1,
  availableCollateral: 40,
  reservedMargin: 56,
  basePosition: 72,
  quoteEntryValue: 88,
  realizedPnl: 104,
  lastFundingAccumulator: 120,
  openBidExposure: 136,
  openAskExposure: 152,
  openOrderCount: 168,
  liquidationState: 172,
  sequence: 176,
} as const;

export const LIQUIDATION_STATE = { healthy: 0, warning: 1, liquidatable: 2, bankrupt: 3 } as const;
export type LiquidationStateLabel = "healthy" | "warning" | "liquidatable" | "bankrupt" | "unknown";

export interface TraderSeatView {
  seatIndex: number;
  owner: string;
  availableCollateral: bigint;
  reservedMargin: bigint;
  basePosition: bigint;
  quoteEntryValue: bigint;
  realizedPnl: bigint;
  lastFundingAccumulator: bigint;
  openBidExposure: bigint;
  openAskExposure: bigint;
  openOrderCount: number;
  liquidationState: LiquidationStateLabel;
  sequence: bigint;
}

function readI128(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  const signBit = 1n << 127n;
  return value >= signBit ? value - (signBit << 1n) : value;
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let leadingZeros = 0;
  for (const byte of bytes) { if (byte !== 0) break; leadingZeros += 1; }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    out = alphabet[Number(remainder)] + out;
  }
  return alphabet[0].repeat(leadingZeros) + out;
}

function liquidationLabel(raw: number): LiquidationStateLabel {
  switch (raw) {
    case LIQUIDATION_STATE.healthy: return "healthy";
    case LIQUIDATION_STATE.warning: return "warning";
    case LIQUIDATION_STATE.liquidatable: return "liquidatable";
    case LIQUIDATION_STATE.bankrupt: return "bankrupt";
    default: return "unknown";
  }
}

/** Returns null for an out-of-range index, a market account too short to
 * contain that seat, or an unoccupied seat -- there is no position to show
 * for a seat nobody has created yet. */
export function decodeTraderSeat(marketBytes: Uint8Array, traderSeatOffset: number, seatIndex: number): TraderSeatView | null {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= MAX_TRADER_SEATS) return null;
  const start = traderSeatOffset + seatIndex * TRADER_SEAT_SIZE;
  if (marketBytes.length < start + TRADER_SEAT_SIZE) return null;
  if (marketBytes[start + SEAT_FIELD_OFFSETS.occupancy] !== 1) return null;
  const view = new DataView(marketBytes.buffer, marketBytes.byteOffset, marketBytes.byteLength);
  return {
    seatIndex,
    owner: base58Encode(marketBytes.slice(start + SEAT_FIELD_OFFSETS.trader, start + SEAT_FIELD_OFFSETS.trader + 32)),
    availableCollateral: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.availableCollateral),
    reservedMargin: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.reservedMargin),
    basePosition: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.basePosition),
    quoteEntryValue: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.quoteEntryValue),
    realizedPnl: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.realizedPnl),
    lastFundingAccumulator: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.lastFundingAccumulator),
    openBidExposure: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.openBidExposure),
    openAskExposure: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.openAskExposure),
    openOrderCount: view.getUint32(start + SEAT_FIELD_OFFSETS.openOrderCount, true),
    liquidationState: liquidationLabel(marketBytes[start + SEAT_FIELD_OFFSETS.liquidationState]),
    sequence: view.getBigUint64(start + SEAT_FIELD_OFFSETS.sequence, true),
  };
}
