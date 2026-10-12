import type { Metadata } from "next";
import { ActivityView } from "@/features/activity/activity-view";

export const metadata: Metadata = { title: "Activity · Equinox", description: "Live fills across Equinox's TSLA and pre-IPO markets, read from the MagicBlock rollup." };

export default function ActivityPage() {
  return <ActivityView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
