import { NextResponse } from "next/server";
import { persistentSession, SESSION_COOKIE, verifyPrivyAccessToken } from "@/lib/auth/session";
import { cleanupPersistentSessions, routeSessionDatabase, storePersistentSession } from "@/lib/auth/route-session-store";
import { randomBytes } from "node:crypto";

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === "production" && request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Origin rejected" }, { status: 403 });
    const limiterKey = request.headers.get("x-forwarded-for") ?? "unknown";
    const now = Date.now();
    const record = (globalThis as Record<string, unknown>).__STOCKSTREAM_AUTH_LIMIT__ as Map<string, number[]> | undefined;
    const limits = record ?? new Map<string, number[]>();
    if (!record) (globalThis as Record<string, unknown>).__STOCKSTREAM_AUTH_LIMIT__ = limits;
    const recent = (limits.get(limiterKey) ?? []).filter((stamp) => now - stamp < 60_000);
    if (recent.length >= 10) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    limits.set(limiterKey, [...recent, now]);
    const body = await request.json() as { accessToken?: unknown; walletAddress?: unknown };
    if (typeof body.accessToken !== "string" || typeof body.walletAddress !== "string") {
      return NextResponse.json({ error: "accessToken and walletAddress are required" }, { status: 400 });
    }
    const verified = await verifyPrivyAccessToken(body.accessToken);
    const result = persistentSession({ privyUserId: verified.user_id, tokenExpiry: verified.expiration * 1000, walletAddress: body.walletAddress, userAgent: request.headers.get("user-agent") ?? undefined });
    const database = routeSessionDatabase();
    await cleanupPersistentSessions(database, now);
    await storePersistentSession(database, result.cookieValue, result.session);
    const csrf = randomBytes(24).toString("base64url");
    const response = NextResponse.json({ userId: result.session.privyUserId, walletAddress: result.session.walletAddress });
    response.cookies.set(SESSION_COOKIE, result.cookieValue, {
      httpOnly: true, secure: true, sameSite: "lax",
      path: "/", expires: new Date(result.session.expiresAt)
    });
    response.cookies.set("stockstream_csrf", csrf, { httpOnly: false, secure: true, sameSite: "lax", path: "/", expires: new Date(result.session.expiresAt) });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Authentication failed" }, { status: 401 });
  }
}
