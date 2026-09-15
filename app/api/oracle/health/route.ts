import { NextResponse } from "next/server";
import { pythHealth } from "@/lib/server/pyth-keeper";

export function GET() {
  return NextResponse.json(pythHealth(process.env));
}
