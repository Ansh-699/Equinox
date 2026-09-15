export type MarketEventKind = "book" | "fill" | "funding" | "health" | "oracle";

export interface MarketEvent {
  id: string;
  symbol: string;
  kind: MarketEventKind;
  slot?: number;
  payload: Record<string, unknown>;
  observedAt: number;
}

export interface MarketDefinition {
  symbol: string;
  instrumentId: string;
  marketIndex: number;
  marketPda: string;
  vaultPda: string;
  status: "active" | "paused" | "restricted";
  oracleFeedId: string;
  sessionPolicy: "regular" | "extended" | "close-only";
}
