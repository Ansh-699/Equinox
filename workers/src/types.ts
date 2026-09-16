export type MarketEventKind = "book" | "fill" | "funding" | "health" | "oracle" | "custody";

export interface MarketEvent {
  id: string;
  symbol: string;
  kind: MarketEventKind;
  slot?: number;
  payload: Record<string, unknown>;
  observedAt: number;
  sequence?: number;
  domain?: "l1" | "er";
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
  instrumentStatus?: "proposed" | "initialized" | "oracle-ready" | "active" | "close-only" | "halted" | "corporate-action" | "closed";
  commitSequence?: number;
  erSequence?: number;
}

export interface MarketSnapshot {
  symbol: string;
  sequence: number;
  domain: "l1" | "er";
  market: MarketDefinition;
  events: MarketEvent[];
  capturedAt: number;
}

export interface IndexedCursor {
  market: string;
  domain: "l1" | "er";
  sequence: number;
  slot: number;
}
