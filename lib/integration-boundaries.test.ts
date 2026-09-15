import { describe, expect, it } from "vitest";
import { deposit, deriveVault, deriveVaultAuthority, SPL_TOKEN_PROGRAM, tokenTransferMeta, withdraw } from "./custody";
import { OracleTracker, requirePythServerConfig } from "./oracle";
import { COMMIT_INTERVAL_MS, encodeCommit, rejectMixedWritableDomains, validateCallback, validateHotCluster } from "./magicblock";
import { authorize } from "./trading-session";
import { requireClientOrderId } from "./execution-boundary";

describe("custody boundaries", () => {
  const config = { mint: "verified-devnet-mint-config", decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM };
  const token = { address: "source", owner: "wallet", mint: config.mint, tokenProgram: SPL_TOKEN_PROGRAM, amount: 100n };
  it("derives distinct canonical vault addresses", () => expect(deriveVault("program", "market")).not.toBe(deriveVaultAuthority("program", "market")));
  it("reconciles deposit and exact healthy withdrawal", () => {
    const ledger = deposit({ available: 0n, reserved: 20n, fees: 0n, insurance: 0n }, token, 50n, config, "wallet");
    expect(withdraw(ledger, 30n).available).toBe(20n);
  });
  it("rejects wrong token account and preserves CPI ordering", () => {
    expect(() => deposit({ available: 0n, reserved: 0n, fees: 0n, insurance: 0n }, { ...token, mint: "wrong" }, 1n, config, "wallet")).toThrow();
    expect(tokenTransferMeta("source", "vault", "wallet")[0]).toBe("source");
  });
});

describe("oracle and lifecycle boundaries", () => {
  it("requires retry-safe client order identifiers", () => {
    expect(requireClientOrderId("order_123456")).toBe("order_123456");
    expect(() => requireClientOrderId("x")).toThrow();
  });
  it("requires server-only Pyth configuration", () => expect(() => requirePythServerConfig({})).toThrow("PYTH_PRO_API_KEY"));
  it("accepts monotonic bounded oracle data once", () => {
    const tracker = new OracleTracker({ feedId: "verified", channel: "fixed_rate@200ms", maxAgeMs: 1000, maxConfidence: 2n, exponent: -2 });
    tracker.accept({ feedId: "verified", channel: "fixed_rate@200ms", price: 100n, exponent: -2, confidence: 1n, timestamp: 100, session: "Regular", status: "Open" }, 200);
    expect(() => tracker.accept({ feedId: "verified", channel: "fixed_rate@200ms", price: 100n, exponent: -2, confidence: 1n, timestamp: 100, session: "Regular", status: "Open" }, 200)).toThrow();
  });
  it("validates ER account domains and commit callback", () => {
    validateHotCluster([{ address: "arena", domain: "er", writable: true }]);
    expect(() => rejectMixedWritableDomains([{ address: "a", domain: "er", writable: true }, { address: "b", domain: "l1", writable: true }])).toThrow();
    expect(new DataView(encodeCommit(4n).buffer).getBigUint64(2, true)).toBe(4n);
    expect(COMMIT_INTERVAL_MS).toBe(30_000);
    expect(validateCallback(Uint8Array.from([196, 28, 41, 206, 48, 37, 51, 167]))).toBe(true);
  });
  it("enforces scoped session limits and nonce", () => {
    const session = { owner: "owner", signer: "session", programId: "program", market: "market", seat: 1, expiresAt: 100, actions: ["place" as const], maxOrderNotional: 10n, maxExposure: 20n, maxOpenOrders: 2, nonce: 3n, revoked: false };
    authorize(session, { signer: "session", programId: "program", market: "market", seat: 1, action: "place", notional: 5n, exposure: 10n, openOrders: 1, nonce: 3n, now: 50 });
    expect(() => authorize({ ...session, revoked: true }, { signer: "session", programId: "program", market: "market", seat: 1, action: "place", notional: 5n, exposure: 10n, openOrders: 1, nonce: 3n, now: 50 })).toThrow();
  });
});
