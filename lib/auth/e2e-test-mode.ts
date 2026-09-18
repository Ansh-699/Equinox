/**
 * Server-side half of the E2E test-mode auth bypass
 * (components/test-auth-provider.tsx is the client half). Double-gated so
 * a stray NEXT_PUBLIC_E2E_TEST_MODE=1 left set can never activate a real
 * auth bypass in production: both the explicit flag AND
 * NODE_ENV !== "production" must hold. The token itself
 * ("e2e-test-token") is a fixed, public, non-secret string -- it proves
 * nothing on its own; it is only meaningful when this gate is open.
 */
export const E2E_TEST_TOKEN = "e2e-test-token";

export function isE2eTestModeServer(): boolean {
  return process.env.NEXT_PUBLIC_E2E_TEST_MODE === "1" && process.env.NODE_ENV !== "production";
}

export function verifyE2eTestToken(walletAddress: string): { user_id: string; expiration: number; wallets: readonly string[] } {
  return { user_id: "e2e-test-user", expiration: Math.floor(Date.now() / 1000) + 3600, wallets: [walletAddress] };
}
