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
  marketIndex: number;
  status: "active" | "paused" | "restricted";
  oracleFeedId: string;
}
