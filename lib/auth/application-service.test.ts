import { describe, expect, it } from "vitest";
import { exchangePrivySession, createRateLimiter, logoutSession, readSession, requireTrustedOrigin } from "./application-service";
import type { SessionDatabase } from "./d1-session-store";

function db(): SessionDatabase {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    prepare(sql) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() { const row = rows.get(String(values[0])); return row && row.revokedAt == null && Number(row.expiresAt) > Number(values[1]) ? row as T : null; },
            async run() {
              if (sql.startsWith("INSERT")) rows.set(String(values[0]), { idHash: values[0], privyUserId: values[1], walletAddress: values[2], createdAt: values[3], expiresAt: values[4], lastUsedAt: values[5], revokedAt: values[6], userAgentHash: values[7] });
              if (sql.startsWith("UPDATE") && sql.includes("revoked_at")) { const row = rows.get(String(values[2])); if (row) row.revokedAt = values[0]; }
            },
          };
        },
      };
    },
  };
}

describe("persistent application session service", () => {
  it("stores only the hash and supports multi-reader lookup/logout", async () => {
    const store = db();
    const result = await exchangePrivySession(store, { accessToken: "privy-token", walletAddress: "wallet", expectedOrigin: "https://app.test", origin: "https://app.test" }, { verify: async () => ({ user_id: "did:privy:test", expiration: 2_000_000_000 }) }, 1_000);
    expect(result.session.idHash).not.toContain("privy-token");
    expect(await readSession(store, result.cookieValue, 1_001)).not.toBeNull();
    await logoutSession(store, result.cookieValue, result.csrfToken, result.csrfToken, 1_002);
    expect(await readSession(store, result.cookieValue, 1_003)).toBeNull();
  });
  it("rejects origin and rate limits", () => {
    expect(() => requireTrustedOrigin("b", "a")).toThrow("Origin rejected");
    const allow = createRateLimiter(1, 1000); expect(allow("a", 1)).toBe(true); expect(allow("a", 2)).toBe(false);
  });
});
