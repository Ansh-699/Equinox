import { describe, expect, it } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { decodeMarketHeader, fetchAuthoritativeMarketState, MARKET_HEADER_SIZE, MarketMode } from "./market-state";
import { SolanaL1Transport } from "./chain-transports";

const AUTHORITY = "SysvarRent111111111111111111111111111111111";
const EMERGENCY = "SysvarC1ock11111111111111111111111111111111";

function headerFixture(overrides: { mode?: number; oracleValid?: boolean } = {}): Uint8Array {
  const bytes = new Uint8Array(MARKET_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("STKMRK01"), 0);
  view.setUint16(8, 2, true); // version
  view.setUint8(10, 1); // initialized
  view.setUint8(11, overrides.mode ?? MarketMode.Open);
  bytes.set(getBase58Encoder().encode(AUTHORITY), 12);
  bytes.set(getBase58Encoder().encode(EMERGENCY), 76);
  view.setUint16(194, 1_000, true);
  view.setUint16(198, 5, true);
  view.setUint16(200, 15, true);
  view.setUint32(202, 10, true);
  view.setBigInt64(238, 500n, true);
  view.setBigUint64(254, 42n, true);
  view.setBigUint64(262, 7n, true);
  view.setBigInt64(270, 123n, true);
  view.setBigUint64(286, 1_700_000_000n, true);
  view.setUint8(294, overrides.oracleValid === false ? 0 : 1);
  view.setBigInt64(295, 100_000n, true);
  view.setBigUint64(303, 1_700_000_050n, true);
  return bytes;
}

describe("decodeMarketHeader", () => {
  it("decodes every field this module's keepers rely on", () => {
    const state = decodeMarketHeader(headerFixture());
    expect(state).not.toBeNull();
    expect(state?.mode).toBe(MarketMode.Open);
    expect(state?.marketAuthority).toBe(AUTHORITY);
    expect(state?.emergencyAuthority).toBe(EMERGENCY);
    expect(state?.maintenanceMarginBps).toBe(1_000);
    expect(state?.makerFeeBps).toBe(5);
    expect(state?.takerFeeBps).toBe(15);
    expect(state?.maximumLeverage).toBe(10);
    expect(state?.currentOpenInterest).toBe(500n);
    expect(state?.globalOrderSequence).toBe(42n);
    expect(state?.globalEventSequence).toBe(7n);
    expect(state?.fundingAccumulator).toBe(123n);
    expect(state?.lastFundingTimestamp).toBe(1_700_000_000n);
    expect(state?.oracleValid).toBe(true);
    expect(state?.lastVerifiedOraclePrice).toBe(100_000n);
    expect(state?.lastVerifiedOracleTimestamp).toBe(1_700_000_050n);
  });

  it("returns null for a too-short buffer, wrong discriminator, or uninitialized account", () => {
    expect(decodeMarketHeader(new Uint8Array(10))).toBeNull();
    const wrongDiscriminator = headerFixture();
    wrongDiscriminator.set(new TextEncoder().encode("XXXXXXXX"), 0);
    expect(decodeMarketHeader(wrongDiscriminator)).toBeNull();
    const uninitialized = headerFixture();
    new DataView(uninitialized.buffer).setUint8(10, 0);
    expect(decodeMarketHeader(uninitialized)).toBeNull();
  });

  it("reports oracleValid: false when the header says so", () => {
    expect(decodeMarketHeader(headerFixture({ oracleValid: false }))?.oracleValid).toBe(false);
  });
});

describe("fetchAuthoritativeMarketState", () => {
  it("fetches through the transport and decodes the returned account", async () => {
    const bytes = headerFixture();
    const base64 = btoa(String.fromCharCode(...bytes));
    const fetcher = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ data: [base64, "base64"], owner: "x", lamports: 1 }] } }), { status: 200 });
    const transport = new SolanaL1Transport("https://l1.test", fetcher as typeof fetch);
    const state = await fetchAuthoritativeMarketState(transport, "MarketPda11111111111111111111111111111111");
    expect(state?.mode).toBe(MarketMode.Open);
  });

  it("returns null when the account doesn't exist", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [null] } }), { status: 200 });
    const transport = new SolanaL1Transport("https://l1.test", fetcher as typeof fetch);
    expect(await fetchAuthoritativeMarketState(transport, "MarketPda11111111111111111111111111111111")).toBeNull();
  });
});
