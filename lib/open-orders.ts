/**
 * Open-orders data boundary. Order keys, prices, quantities, and owners
 * live in the book's PATRICIA-tree arenas (docs/orderbook.md). The V3 Worker
 * aggregate exposes the versioned page layout and Patricia tree identity.
 * This module keeps the UI independent of transport details and still fails
 * closed whenever the aggregate is absent or a node is malformed.
 */

import { fetchV3Aggregate } from "@/lib/v3-aggregate";

export interface OpenOrderView {
  orderKey: bigint;
  side: "bid" | "ask";
  tree: "fixed" | "oracle-pegged";
  price: bigint;
  quantity: bigint;
  filledQuantity: bigint;
  postOnly: boolean;
  reduceOnly: boolean;
  expiresAt: bigint | null;
}

export type OpenOrdersFetchResult =
  | { status: "unavailable"; reason: string }
  | { status: "ready"; orders: readonly OpenOrderView[]; asOfSlot: number | null };

export interface OpenOrdersAdapter {
  fetchOpenOrders(input: { marketPda: string; seatIndex: number }): Promise<OpenOrdersFetchResult>;
}

export const OPEN_ORDERS_UNAVAILABLE_REASON =
  "Open orders require a complete V3 shard aggregate; the authoritative market state is currently unavailable.";

/** Explicit V2/unknown-version fallback. It never decodes bytes from the
 * monolithic market; configured V3 flows use createV3OpenOrdersAdapter below. */
export const unimplementedOpenOrdersAdapter: OpenOrdersAdapter = {
  async fetchOpenOrders() {
    return { status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON };
  },
};

interface V3OrderNode {
  key: string;
  side?: 0 | 1;
  owner?: number;
  quantity?: string;
  expiresAt?: string;
  priceOrOffset?: string;
  postOnly?: boolean;
  reduceOnly?: boolean;
  tree?: "fixed" | "oracle-pegged";
}
interface V3AggregateResponse {
  asOfSlot?: number | null;
  core?: { lastVerifiedOraclePrice?: string };
  completeExecutionState?: boolean;
  orderBook?: { bids?: readonly V3OrderNode[]; asks?: readonly V3OrderNode[] };
}

function bigintField(value: string | undefined): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function fixedPrice(key: bigint, side: "bid" | "ask"): bigint {
  const normalized = key >> 64n;
  return side === "ask" ? normalized : (2n ** 64n - 1n) - normalized;
}

/** Reads the Worker's authoritative V3 aggregate. The owner field is the
 * protocol seat index, not a wallet address, so filtering is deterministic.
 * Oracle-pegged orders use the verified core mark plus their stored offset;
 * if that mark is unavailable the adapter reports the read unavailable. */
export function createV3OpenOrdersAdapter(input: {
  marketApiUrl: string;
  core: string;
}): OpenOrdersAdapter {
  return {
    async fetchOpenOrders({ seatIndex }) {
      const aggregate = await fetchV3Aggregate(input.core).catch(() => null) as V3AggregateResponse | null;
      if (!aggregate) return { status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON };
      if (aggregate.completeExecutionState !== true || !aggregate.orderBook) {
        return { status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON };
      }
      const mark = bigintField(aggregate.core?.lastVerifiedOraclePrice);
      const nodes = [...(aggregate.orderBook.bids ?? []), ...(aggregate.orderBook.asks ?? [])];
      const orders: OpenOrderView[] = [];
      for (const node of nodes) {
        if (node.owner !== seatIndex || (node.side !== 0 && node.side !== 1) || !node.tree) continue;
        const key = bigintField(node.key);
        const quantity = bigintField(node.quantity);
        const offset = bigintField(node.priceOrOffset);
        const expires = bigintField(node.expiresAt);
        if (key === null || quantity === null || offset === null || expires === null) {
          return { status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON };
        }
        const side = node.side === 0 ? "bid" : "ask";
        const price = node.tree === "fixed" ? fixedPrice(key, side) : mark === null ? null : mark + offset;
        if (price === null || price <= 0n) return { status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON };
        orders.push({
          orderKey: key,
          side,
          tree: node.tree,
          price,
          quantity,
          filledQuantity: 0n,
          postOnly: node.postOnly === true,
          reduceOnly: node.reduceOnly === true,
          expiresAt: expires === 2n ** 64n - 1n ? null : expires,
        });
      }
      return { status: "ready", orders, asOfSlot: typeof aggregate.asOfSlot === "number" ? aggregate.asOfSlot : null };
    },
  };
}

export type OpenOrdersViewState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready"; orders: readonly OpenOrderView[]; stale: boolean };

/** Pure classification of one fetch attempt against whatever the previous
 * state was -- kept separate from the polling loop so it's directly
 * testable. A transport-level failure (`error` param set) falls back to
 * the last known "ready" data marked `stale: true` rather than blanking
 * the table -- stale real data is more useful than no data, as long as
 * it's honestly labeled. A failure with no prior data to fall back on is
 * a hard "error" state. */
export function classifyOpenOrdersResult(
  previous: OpenOrdersViewState,
  result: OpenOrdersFetchResult | null,
  error?: unknown,
): OpenOrdersViewState {
  if (result === null) {
    if (previous.kind === "ready") return { ...previous, stale: true };
    return { kind: "error", message: error instanceof Error ? error.message : "Failed to load open orders" };
  }
  if (result.status === "unavailable") return { kind: "unavailable", reason: result.reason };
  return result.orders.length === 0 ? { kind: "empty" } : { kind: "ready", orders: result.orders, stale: false };
}
