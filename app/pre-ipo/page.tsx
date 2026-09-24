import type { Metadata } from "next";
import { PreIpoView } from "@/features/pre-ipo/pre-ipo-view";

export const metadata: Metadata = { title: "Pre-IPO · Equinox" };

export default function PreIpoPage() {
  return <PreIpoView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
