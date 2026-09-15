import { createHash, randomBytes } from "node:crypto";
import { PrivyClient } from "@privy-io/node";

export const SESSION_COOKIE = "stockstream_session";
const SESSION_TTL_MS = 60 * 60 * 1000;

export interface ApplicationSession {
  idHash: string;
  privyUserId: string;
  walletAddress: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
  userAgentHash: string;
}

type VerifiedToken = { user_id: string; expiration: number };
type TokenVerifier = (token: string) => Promise<VerifiedToken>;

const sessions = new Map<string, ApplicationSession>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function configuredVerifier(): TokenVerifier {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Privy server authentication is not configured");
  const client = new PrivyClient({ appId, appSecret });
  return async (token) => {
    const verified = await client.utils().auth().verifyAccessToken(token);
    return { user_id: verified.user_id, expiration: verified.expiration };
  };
}

export async function createApplicationSession(input: {
  accessToken: string;
  walletAddress: string;
  userAgent?: string;
  verify?: TokenVerifier;
  now?: number;
}): Promise<{ cookieValue: string; session: ApplicationSession }> {
  if (!input.accessToken) throw new Error("Missing Privy access token");
  if (!input.walletAddress) throw new Error("Missing Solana wallet address");
  const now = input.now ?? Date.now();
  const verified = await (input.verify ?? configuredVerifier())(input.accessToken);
  const tokenExpiry = verified.expiration * 1000;
  if (!verified.user_id || !Number.isFinite(tokenExpiry) || tokenExpiry <= now) throw new Error("Expired Privy access token");
  const rawSessionId = randomBytes(32).toString("base64url");
  const session: ApplicationSession = {
    idHash: hash(rawSessionId),
    privyUserId: verified.user_id,
    walletAddress: input.walletAddress,
    createdAt: now,
    expiresAt: Math.min(now + SESSION_TTL_MS, tokenExpiry),
    lastUsedAt: now,
    revokedAt: null,
    userAgentHash: hash(input.userAgent ?? "")
  };
  sessions.set(session.idHash, session);
  return { cookieValue: rawSessionId, session };
}

export function getApplicationSession(rawSessionId: string | undefined, now = Date.now()): ApplicationSession | null {
  if (!rawSessionId) return null;
  const session = sessions.get(hash(rawSessionId));
  if (!session || session.revokedAt !== null || session.expiresAt <= now) return null;
  session.lastUsedAt = now;
  return session;
}

export function revokeApplicationSession(rawSessionId: string | undefined): boolean {
  if (!rawSessionId) return false;
  const session = sessions.get(hash(rawSessionId));
  if (!session) return false;
  session.revokedAt = Date.now();
  return true;
}

export function clearApplicationSessionsForTests() { sessions.clear(); }

