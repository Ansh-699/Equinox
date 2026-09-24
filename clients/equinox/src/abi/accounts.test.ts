import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeMarketHeader } from "./accounts";
import { MARKET_ACCOUNT_SIZE } from "./constants";

/**
 * Golden-vector test for the market account header decoder, byte-offset
 * verified against `programs/equinox/src/state.rs::MarketStateHeader`
 * (a `#[repr(C, packed(1))]` struct) field-by-field, not transcribed from
 * either TypeScript file. Every field gets a DISTINCT value so a decoder
 * reading the wrong offset (e.g. this file's own real bug, found during
 * ABI-parity hardening: `liquidationFeeBps` was reading the same offset
 * as `maintenanceMarginBps`, 194, instead of its own 196) shows up as a
 * wrong value rather than an accidental pass.
 */
function buildMarketHeaderFixture(): Uint8Array {
  const bytes = new Uint8Array(MARKET_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  const writeKey = (offset: number, seed: number) => bytes.set(new PublicKey(Buffer.alloc(32, seed)).toBytes(), offset);

  bytes.set(Buffer.from("STKMRK01", "ascii"), 0); // discriminator
  view.setUint16(8, 2, true); // version
  bytes[10] = 1; // initialized
  bytes[11] = 1; // mode (Open)
  writeKey(12, 11); // market_authority
  writeKey(44, 22); // pause_authority
  writeKey(76, 33); // emergency_authority
  writeKey(108, 44); // collateral_mint
  writeKey(140, 55); // collateral_token_program
  view.setInt32(172, -6, true); // price_exponent
  view.setBigUint64(176, 1_000n, true); // base_lot_size
  view.setBigUint64(184, 2_000n, true); // quote_lot_size
  view.setUint16(192, 500, true); // initial_margin_bps
  view.setUint16(194, 300, true); // maintenance_margin_bps
  view.setUint16(196, 150, true); // liquidation_fee_bps -- the offset the real bug collided with 194
  view.setUint16(198, 2, true); // maker_fee_bps
  view.setUint16(200, 5, true); // taker_fee_bps
  view.setUint32(202, 20, true); // maximum_leverage
  // maximum_position (i128) @206, maximum_open_interest (i128) @222, current_open_interest (i128) @238
  view.setBigUint64(206, 111n, true);
  view.setBigUint64(222, 222n, true);
  view.setBigUint64(238, 333n, true);
  view.setBigUint64(254, 7n, true); // global_order_sequence
  view.setBigUint64(262, 8n, true); // global_event_sequence
  view.setBigUint64(270, 444n, true); // funding_accumulator (i128) @270
  view.setBigUint64(286, 9_000n, true); // last_funding_timestamp
  bytes[294] = 1; // oracle_valid
  view.setBigInt64(295, 123_456n, true); // last_verified_oracle_price
  view.setBigUint64(303, 9_999n, true); // last_verified_oracle_timestamp
  view.setUint32(311, 512, true); // bid_arena_offset
  view.setUint32(315, 91_152, true); // ask_arena_offset
  view.setUint32(319, 181_792, true); // trader_seat_offset
  view.setUint32(323, 214_560, true); // fill_event_offset
  return bytes;
}

describe("decodeMarketHeader golden vector", () => {
  it("decodes every field at its verified Rust struct offset, none colliding with another", () => {
    const header = decodeMarketHeader(buildMarketHeaderFixture());
    expect(header).not.toBeNull();
    expect(header!.discriminator).toBe("STKMRK01");
    expect(header!.version).toBe(2);
    expect(header!.initialized).toBe(true);
    expect(header!.mode).toBe(1);
    expect(header!.priceExponent).toBe(-6);
    expect(header!.baseLotSize).toBe(1_000n);
    expect(header!.quoteLotSize).toBe(2_000n);
    expect(header!.initialMarginBps).toBe(500);
    expect(header!.maintenanceMarginBps).toBe(300);
    // The regression case: this must be 150 (its own offset 196), never
    // 300 (maintenanceMarginBps's value at 194).
    expect(header!.liquidationFeeBps).toBe(150);
    expect(header!.makerFeeBps).toBe(2);
    expect(header!.takerFeeBps).toBe(5);
    expect(header!.maximumLeverage).toBe(20);
    expect(header!.maximumPosition).toBe(111n);
    expect(header!.maximumOpenInterest).toBe(222n);
    expect(header!.currentOpenInterest).toBe(333n);
    expect(header!.globalOrderSequence).toBe(7n);
    expect(header!.globalEventSequence).toBe(8n);
    expect(header!.fundingAccumulator).toBe(444n);
    expect(header!.lastFundingTimestamp).toBe(9_000n);
    expect(header!.oracleValid).toBe(true);
    expect(header!.lastVerifiedOraclePrice).toBe(123_456n);
    expect(header!.lastVerifiedOracleTimestamp).toBe(9_999n);
    expect(header!.bidArenaOffset).toBe(512);
    expect(header!.askArenaOffset).toBe(91_152);
    expect(header!.traderSeatOffset).toBe(181_792);
    expect(header!.fillEventOffset).toBe(214_560);
  });

  it("rejects an account shorter than the header, a wrong discriminator, and a wrong version", () => {
    expect(decodeMarketHeader(new Uint8Array(511))).toBeNull();
    const wrongDiscriminator = buildMarketHeaderFixture();
    wrongDiscriminator.set(Buffer.from("XXXXXXXX", "ascii"), 0);
    expect(decodeMarketHeader(wrongDiscriminator)).toBeNull();
    const wrongVersion = buildMarketHeaderFixture();
    new DataView(wrongVersion.buffer).setUint16(8, 99, true);
    expect(decodeMarketHeader(wrongVersion)).toBeNull();
  });
});
