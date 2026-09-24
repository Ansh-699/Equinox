import type { Metadata } from "next";
import { LaunchView } from "@/features/launch/launch-view";

export const metadata: Metadata = { title: "Launch · Equinox" };

export default function LaunchPage() {
  return <LaunchView />;
}
