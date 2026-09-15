import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { revokeApplicationSession, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST() {
  const cookieStore = await cookies();
  revokeApplicationSession(cookieStore.get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
