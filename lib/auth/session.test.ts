import { beforeEach, describe, expect, it } from "vitest";
import { clearApplicationSessionsForTests, createApplicationSession, getApplicationSession, revokeApplicationSession } from "./session";

const verify = async () => ({ user_id: "did:privy:test", expiration: 2_000 });

describe("application authentication sessions", () => {
  beforeEach(() => clearApplicationSessionsForTests());

  it("creates a hashed session after verified token authentication", async () => {
    const result = await createApplicationSession({ accessToken: "valid", walletAddress: "wallet", verify, now: 1_000_000 });
    expect(result.cookieValue).not.toBe("valid");
    expect(result.session.idHash).not.toContain(result.cookieValue);
    expect(getApplicationSession(result.cookieValue, 1_000_001)?.privyUserId).toBe("did:privy:test");
  });

  it("rejects expired tokens and expires application sessions", async () => {
    await expect(createApplicationSession({ accessToken: "expired", walletAddress: "wallet", verify: async () => ({ user_id: "u", expiration: 1 }), now: 2_000 })).rejects.toThrow("Expired");
    const result = await createApplicationSession({ accessToken: "valid", walletAddress: "wallet", verify, now: 1_000_000 });
    expect(getApplicationSession(result.cookieValue, result.session.expiresAt)).toBeNull();
  });

  it("rejects a verifier failure without creating a session", async () => {
    await expect(createApplicationSession({ accessToken: "bad-signature", walletAddress: "wallet", verify: async () => { throw new Error("invalid signature"); } })).rejects.toThrow("invalid signature");
  });

  it("revokes sessions and rejects missing cookies", async () => {
    expect(getApplicationSession(undefined)).toBeNull();
    const result = await createApplicationSession({ accessToken: "valid", walletAddress: "wallet", verify, now: 1_000_000 });
    expect(revokeApplicationSession(result.cookieValue)).toBe(true);
    expect(getApplicationSession(result.cookieValue)).toBeNull();
  });
});
