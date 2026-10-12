import type { Metadata } from "next";
import { LaunchView } from "@/features/launch/launch-view";

export const metadata: Metadata = { title: "Launch · Equinox", description: "Launch stock-themed tokens on Meteora bonding curves priced in USDC, graduate them to DAMM v2, and trade them as perps." };

export default function LaunchPage() {
  return <LaunchView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
