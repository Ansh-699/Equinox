import { NextResponse } from "next/server";
import { createApplicationSession, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { accessToken?: unknown; walletAddress?: unknown };
    if (typeof body.accessToken !== "string" || typeof body.walletAddress !== "string") {
      return NextResponse.json({ error: "accessToken and walletAddress are required" }, { status: 400 });
    }
    const result = await createApplicationSession({
      accessToken: body.accessToken,
      walletAddress: body.walletAddress,
      userAgent: request.headers.get("user-agent") ?? undefined
    });
    const response = NextResponse.json({ userId: result.session.privyUserId, walletAddress: result.session.walletAddress });
    response.cookies.set(SESSION_COOKIE, result.cookieValue, {
      httpOnly: true, secure: true, sameSite: "lax",
      path: "/", expires: new Date(result.session.expiresAt)
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Authentication failed" }, { status: 401 });
  }
}
