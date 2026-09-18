/**
 * Open-orders data boundary. Order keys, prices, quantities, and owners
 * live in the book's PATRICIA-tree arenas (docs/orderbook.md), and there
 * is no canonical, ABI-verified byte layout for that structure yet --
 * raw decoding is explicitly blocked pending the main-agent's manifest
 * (see AGENTS.md / the handoff checklist). This module is the seam: a
 * typed adapter interface the UI (features/orders/*) can already be built
 * and tested against, and one concrete implementation --
 * `unimplementedOpenOrdersAdapter` -- that is always honest about not
 * having real data. It NEVER returns a fabricated or mocked order.
 */

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
  "Open orders require the canonical order-book layout manifest (order keys/prices/owners live in the PATRICIA-tree book arenas) -- blocked on the main-agent ABI handoff.";

/** The only adapter wired into the app today. Always reports honestly
 * that there is no data, rather than decoding raw book bytes without a
 * verified layout or showing placeholder/mock rows. */
export const unimplementedOpenOrdersAdapter: OpenOrdersAdapter = {
  async fetchOpenOrders() {
    return { status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON };
  },
};

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
