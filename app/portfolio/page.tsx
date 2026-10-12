import type { Metadata } from "next";
import { PortfolioView } from "@/features/portfolio/portfolio-view";

export const metadata: Metadata = { title: "Portfolio · Equinox", description: "View your Equinox USDC balances, margin accounts, positions, and recent fills across every market." };

export default function PortfolioPage() {
  return <PortfolioView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
