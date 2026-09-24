import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { routeSessionDatabase, revokePersistentSession } from "@/lib/auth/route-session-store";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const csrf = cookieStore.get("equinox_csrf")?.value;
  if (!csrf || request.headers.get("x-equinox-csrf") !== csrf) return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (raw) await revokePersistentSession(routeSessionDatabase(), raw);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
