import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    mode: process.env.NEXT_PUBLIC_STOCKSTREAM_MODE ?? "demo",
    timestamp: new Date().toISOString()
  });
}
