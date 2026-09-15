import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getApplicationSession, SESSION_COOKIE } from "@/lib/auth/session";

export async function GET() {
  const session = getApplicationSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  return NextResponse.json({ userId: session.privyUserId, walletAddress: session.walletAddress, expiresAt: session.expiresAt });
}

