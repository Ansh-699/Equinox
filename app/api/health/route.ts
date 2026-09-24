import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    mode: process.env.NEXT_PUBLIC_EQUINOX_MODE ?? "demo",
    timestamp: new Date().toISOString()
  });
}
