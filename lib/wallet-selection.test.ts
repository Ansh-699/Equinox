import { describe, expect, it } from "vitest";
import { resolveSelectedWallet } from "./wallet-selection";

const walletA = { address: "AAAA", walletClientType: "e2e-test-embedded" };
const walletB = { address: "BBBB", walletClientType: "e2e-test-external" };

describe("resolveSelectedWallet", () => {
  it("never selects anything before Privy authentication, even with wallets discovered", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: false, wallets: [walletA], explicitSelection: null, storedAddress: null })).toBeNull();
  });

  it("auto-selects the single wallet once authenticated", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletA], explicitSelection: null, storedAddress: null })).toBe("AAAA");
  });

  it("fails closed with multiple wallets and no explicit or persisted choice -- never wallets[0]", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletA, walletB], explicitSelection: null, storedAddress: null })).toBeNull();
  });

  it("an explicit choice among multiple wallets wins", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletA, walletB], explicitSelection: "BBBB", storedAddress: null })).toBe("BBBB");
  });

  it("restores a persisted choice when no explicit choice is set", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletA, walletB], explicitSelection: null, storedAddress: "BBBB" })).toBe("BBBB");
  });

  it("an explicit choice takes priority over a persisted one", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletA, walletB], explicitSelection: "AAAA", storedAddress: "BBBB" })).toBe("AAAA");
  });

  it("ignores a persisted choice for a wallet that is no longer connected (fails closed, not wallets[0])", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletB], explicitSelection: null, storedAddress: "AAAA" })).toBe("BBBB");
  });

  it("ignores an explicit choice for a wallet that has disconnected -- falls back through persisted/auto rather than staying stuck", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletB], explicitSelection: "AAAA", storedAddress: null })).toBe("BBBB");
  });

  it("a previously-selected wallet disappearing with other wallets still ambiguous resolves to null, not silently another wallet", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [walletA, walletB], explicitSelection: "ZZZZ", storedAddress: null })).toBeNull();
  });

  it("no wallets discovered at all resolves to null even when authenticated", () => {
    expect(resolveSelectedWallet({ privyAuthenticated: true, wallets: [], explicitSelection: null, storedAddress: null })).toBeNull();
  });
});
