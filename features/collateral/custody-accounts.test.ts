import { describe, expect, it } from "vitest";
import { resolveCustodyAccounts } from "./custody-accounts";

const WALLET = "11111111111111111111111111111111";
const MARKET = "SysvarRent111111111111111111111111111111111";
const CORE = "Vote111111111111111111111111111111111111111";

const config = {
  id: "fixture", symbol: "AAPL-PERP", displayName: "Apple", marketSession: "regular" as const,
  live: false, instrumentPda: MARKET, marketPda: MARKET, vaultPda: MARKET,
  scratchPda: () => MARKET, maximumLeverage: 5, initialMarginBps: 2_000, maintenanceMarginBps: 1_000,
};

describe("resolveCustodyAccounts", () => {
  it("retains the legacy custody tuple when V3 is not configured", () => {
    const previous = process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
    delete process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
    try {
      expect(resolveCustodyAccounts(WALLET, MARKET, config)?.v3).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
      else process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS = previous;
    }
  });

  it("derives V3 deposit and withdrawal bundles from the configured core", () => {
    const previous = process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
    const previousMint = process.env.NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT;
    const previousToken = process.env.NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM;
    const previousAuthority = process.env.NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY;
    process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS = CORE;
    process.env.NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT = MARKET;
    process.env.NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM = MARKET;
    process.env.NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY = MARKET;
    try {
      const resolved = resolveCustodyAccounts(WALLET, MARKET, config);
      expect(resolved?.v3?.deposit.core).toBe(CORE);
      expect(resolved?.v3?.deposit.seatShard).toBeTruthy();
      expect(resolved?.v3?.deposit.eventShards).toHaveLength(4);
      expect(resolved?.v3?.withdraw.bookPages).toHaveLength(18);
      expect(resolved?.v3?.withdraw.seatShards).toHaveLength(4);
      expect(resolved?.v3?.withdraw.eventShards).toHaveLength(4);
      expect(resolved?.v3?.withdraw.session).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
      else process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS = previous;
      if (previousMint === undefined) delete process.env.NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT;
      else process.env.NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT = previousMint;
      if (previousToken === undefined) delete process.env.NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM;
      else process.env.NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM = previousToken;
      if (previousAuthority === undefined) delete process.env.NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY;
      else process.env.NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY = previousAuthority;
    }
  });
});
