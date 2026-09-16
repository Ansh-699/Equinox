import { randomBytes } from "node:crypto";
import { persistentSession, verifyPrivyAccessToken, type ApplicationSession } from "./session";
import { cleanupExpiredSessions, lookupSession, persistSession, revokeSession, touchSession, type SessionDatabase } from "./d1-session-store";

export interface PrivyVerifier { verify(token: string): Promise<{ user_id: string; expiration: number; wallets?: readonly string[] }> }
export interface SessionExchangeInput { accessToken: string; walletAddress: string; userAgent?: string; origin?: string; expectedOrigin?: string; }
export interface SessionExchangeResult { cookieValue: string; session: ApplicationSession; csrfToken: string }

export function requireTrustedOrigin(origin: string | null | undefined, expected: string | undefined): void {
  if (expected && origin !== expected) throw new Error("Origin rejected");
}

export function requireCsrf(cookie: string | undefined, header: string | null): void {
  if (!cookie || cookie !== header) throw new Error("CSRF validation failed");
}

export function createRateLimiter(limit: number, windowMs: number) {
  const attempts = new Map<string, number[]>();
  return (key: string, now = Date.now()) => {
    const recent = (attempts.get(key) ?? []).filter((item) => now - item < windowMs);
    if (recent.length >= limit) return false;
    attempts.set(key, [...recent, now]);
    return true;
  };
}

export async function exchangePrivySession(db: SessionDatabase, input: SessionExchangeInput, verifier: PrivyVerifier = { verify: verifyPrivyAccessToken }, now = Date.now()): Promise<SessionExchangeResult> {
  requireTrustedOrigin(input.origin, input.expectedOrigin);
  if (!input.accessToken || !input.walletAddress) throw new Error("Authentication input is incomplete");
  const verified = await verifier.verify(input.accessToken);
  if (!verified.wallets?.includes(input.walletAddress)) throw new Error('Wallet is not linked to authenticated user');
  const result = persistentSession({ privyUserId: verified.user_id, walletAddress: input.walletAddress, tokenExpiry: verified.expiration * 1000, userAgent: input.userAgent, now });
  await cleanupExpiredSessions(db, now);
  await persistSession(db, result.cookieValue, result.session);
  return { ...result, csrfToken: randomBytes(24).toString("base64url") };
}

export async function readSession(db: SessionDatabase, cookie: string | undefined, now = Date.now()) {
  if (!cookie) return null;
  const session = await lookupSession(db, cookie, now);
  if (session) await touchSession(db, cookie, now);
  return session;
}

export async function logoutSession(db: SessionDatabase, cookie: string | undefined, csrfCookie: string | undefined, csrfHeader: string | null, now = Date.now()) {
  requireCsrf(csrfCookie, csrfHeader);
  if (cookie) await revokeSession(db, cookie, now);
}
