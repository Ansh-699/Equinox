import type { Metadata } from "next";
import { LaunchView } from "@/features/launch/launch-view";

export const metadata: Metadata = { title: "Launch on mainnet · Equinox", description: "Launch stock-themed tokens on Meteora bonding curves priced in USDC on Solana mainnet." };

export default function MainnetLaunchPage() {
  return <LaunchView network="mainnet" />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
