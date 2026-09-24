import type { Metadata } from "next";
import { LaunchView } from "@/features/launch/launch-view";

export const metadata: Metadata = { title: "Launch · Equinox" };

export default function LaunchPage() {
  return <LaunchView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
