import type { Metadata } from "next";
import { PreIpoView } from "@/features/pre-ipo/pre-ipo-view";

export const metadata: Metadata = { title: "Pre-IPO · Equinox", description: "Go long or short OpenAI, SpaceX and Anthropic: perps on PreStocks pre-IPO tokens, up to 5×, with one-click baskets." };

export default function PreIpoPage() {
  return <PreIpoView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
