import type { MarketDefinition, MarketEvent, MarketEventKind } from "./types";

const eventKinds = new Set<MarketEventKind>(["book", "fill", "funding", "health", "oracle"]);

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function isAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get("Authorization");
  return Boolean(env.INGESTION_TOKEN) && token === `Bearer ${env.INGESTION_TOKEN}`;
}

export function asMarketEvent(input: unknown): MarketEvent | null {
  if (
    !input ||
    typeof input !== "object" ||
    !("id" in input) ||
    !("symbol" in input) ||
    !("kind" in input) ||
    !("payload" in input) ||
    typeof input.id !== "string" ||
    typeof input.symbol !== "string" ||
    typeof input.kind !== "string" ||
    !eventKinds.has(input.kind as MarketEventKind) ||
    !input.payload ||
    typeof input.payload !== "object"
  ) {
    return null;
  }

  const record = input as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.sequence) ||
    Number(record.sequence) <= 0 ||
    (record.domain !== "l1" && record.domain !== "er")
  ) return null;
  return {
    id: input.id,
    symbol: input.symbol.toUpperCase(),
    kind: input.kind as MarketEventKind,
    slot: "slot" in input && typeof input.slot === "number" ? input.slot : undefined,
    payload: input.payload as Record<string, unknown>,
    observedAt: "observedAt" in input && typeof input.observedAt === "number" ? input.observedAt : Date.now(),
    sequence: "sequence" in input && typeof input.sequence === "number" ? input.sequence : undefined,
    domain: record.domain === "l1" || record.domain === "er" ? record.domain : undefined,
  };
}

export function asMarketDefinition(input: unknown): MarketDefinition | null {
  if (
    !input ||
    typeof input !== "object" ||
    !("symbol" in input) ||
    !("marketIndex" in input) ||
    !("instrumentId" in input) ||
    !("marketPda" in input) ||
    !("vaultPda" in input) ||
    !("sessionPolicy" in input) ||
    !("status" in input) ||
    !("oracleFeedId" in input) ||
    typeof input.symbol !== "string" ||
    typeof input.marketIndex !== "number" ||
    typeof input.instrumentId !== "string" ||
    typeof input.marketPda !== "string" ||
    typeof input.vaultPda !== "string" ||
    typeof input.oracleFeedId !== "string" ||
    (input.status !== "active" && input.status !== "paused" && input.status !== "restricted") ||
    (input.sessionPolicy !== "regular" && input.sessionPolicy !== "extended" && input.sessionPolicy !== "close-only")
  ) return null;

  return {
    symbol: input.symbol.toUpperCase(),
    instrumentId: input.instrumentId,
    marketIndex: input.marketIndex,
    marketPda: input.marketPda,
    vaultPda: input.vaultPda,
    status: input.status,
    oracleFeedId: input.oracleFeedId,
    sessionPolicy: input.sessionPolicy,
  };
}
