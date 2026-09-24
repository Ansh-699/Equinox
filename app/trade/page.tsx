import type { Metadata } from "next";
import { TradingTerminal } from "@/features/trading/trading-terminal";

export const metadata: Metadata = { title: "Trade · Equinox" };

export default function TradePage() {
  return <TradingTerminal />;
}
