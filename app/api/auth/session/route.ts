import { NextResponse } from "next/server";
import { persistentSession, SESSION_COOKIE, verifyPrivyAccessToken } from "@/lib/auth/session";
import { cleanupPersistentSessions, routeSessionDatabase, storePersistentSession } from "@/lib/auth/route-session-store";
import { randomBytes } from "node:crypto";
import { allowSessionExchange } from '@/lib/auth/d1-rate-limit';
import { E2E_TEST_TOKEN, isE2eTestModeServer, verifyE2eTestToken } from "@/lib/auth/e2e-test-mode";

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === "production" && request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Origin rejected" }, { status: 403 });
    const now = Date.now();
    const database = routeSessionDatabase();
    // A shared bucket is conservative and cannot be bypassed by spoofing proxy headers.
    // Bypassed only in E2E test mode (double-gated, never active in production): a real
    // browser-test suite logs in far more than 10x/minute across its scenarios, and this
    // bucket is intentionally global (not per-client) so there is no per-test-run identity
    // to scope it to instead.
    if (!isE2eTestModeServer() && !await allowSessionExchange(database, 'session-exchange', now))
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    const body = await request.json() as { accessToken?: unknown; walletAddress?: unknown };
    if (typeof body.accessToken !== "string" || typeof body.walletAddress !== "string") {
      return NextResponse.json({ error: "accessToken and walletAddress are required" }, { status: 400 });
    }
    const verified = isE2eTestModeServer() && body.accessToken === E2E_TEST_TOKEN
      ? verifyE2eTestToken(body.walletAddress)
      : await verifyPrivyAccessToken(body.accessToken);
    if (!verified.wallets?.includes(body.walletAddress)) return NextResponse.json({error:'Wallet not linked'}, {status:403});
    const result = persistentSession({ privyUserId: verified.user_id, tokenExpiry: verified.expiration * 1000, walletAddress: body.walletAddress, userAgent: request.headers.get("user-agent") ?? undefined });
    await cleanupPersistentSessions(database, now);
    await storePersistentSession(database, result.cookieValue, result.session);
    const csrf = randomBytes(24).toString("base64url");
    const response = NextResponse.json({ userId: result.session.privyUserId, walletAddress: result.session.walletAddress });
    response.cookies.set(SESSION_COOKIE, result.cookieValue, {
      httpOnly: true, secure: true, sameSite: "lax",
      path: "/", expires: new Date(result.session.expiresAt)
    });
    response.cookies.set("equinox_csrf", csrf, { httpOnly: false, secure: true, sameSite: "lax", path: "/", expires: new Date(result.session.expiresAt) });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Authentication failed" }, { status: 401 });
  }
}
