import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { routeSessionDatabase, readPersistentSession, touchPersistentSession } from "@/lib/auth/route-session-store";

export async function GET() {
  const session = await readPersistentSession(routeSessionDatabase(), (await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (raw) await touchPersistentSession(routeSessionDatabase(), raw);
  return NextResponse.json({ userId: session.privyUserId, walletAddress: session.walletAddress, expiresAt: session.expiresAt });
}
