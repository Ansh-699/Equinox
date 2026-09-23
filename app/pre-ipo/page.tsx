import type { Metadata } from "next";
import { PreIpoView } from "@/features/pre-ipo/pre-ipo-view";

export const metadata: Metadata = { title: "Pre-IPO · StockStream" };

export default function PreIpoPage() {
  return <PreIpoView />;
}
