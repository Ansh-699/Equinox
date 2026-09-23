/** Pure pieces of the market maker: the quote ladder and V3 order encoders
 * (kit instructions, byte-compatible with clients/stockstream). No Worker types. */
import { AccountRole, address, type Instruction } from "@solana/kit";
import { STOCKSTREAM_PROGRAM_ID } from "../../clients/stockstream/src/constants";

/** Ten rungs a side: 1 bp at the touch (≈2 bp spread), ≈0.23% deep. */
export const LADDER_BPS = [1n, 2n, 3n, 4n, 6n, 8n, 11n, 14n, 18n, 23n];

export interface Quote { side: "bid" | "ask"; price: bigint; quantity: bigint; rung: number }

/** Post-only ladder around `index`, shifted against inventory so the maker mean-reverts. */
export function ladder(index: bigint, inventory: bigint, random: () => number = Math.random): Quote[] {
  const skew = (index * inventory) / 400_000n;
  return LADDER_BPS.flatMap((bps, rung) => (["bid", "ask"] as const).map((side) => {
    const offset = (index * bps) / 10_000n;
    return {
      side, rung,
      price: (side === "bid" ? index - offset : index + offset) - skew,
      quantity: BigInt(2 + rung * 3 + Math.floor(random() * 4)), // deeper rungs rest more size
    };
  }));
}

export interface RestingOrder { key: bigint; side: "bid" | "ask"; price: bigint; quantity: bigint; expiresAt: bigint }
export type QuoteAction =
  | { kind: "place"; quote: Quote }
  | { kind: "replace"; key: bigint; quote: Quote }
  | { kind: "cancel"; key: bigint };

/**
 * Binance-style incremental requote: pair each target rung with the maker's
 * resting order of the same rank (touch first) and only touch what drifted.
 * A rung is kept while it sits within tolerance (tighter at the touch, looser
 * deep in the book) and is not about to expire; drifted rungs are replaced
 * atomically (never an empty level), missing ones placed, extras cancelled.
 */
export function planQuotes(resting: readonly RestingOrder[], targets: readonly Quote[], index: bigint, now: bigint, refreshBeforeS = 12n): QuoteAction[] {
  const actions: QuoteAction[] = [];
  for (const side of ["bid", "ask"] as const) {
    const better = (a: bigint, b: bigint) => (side === "bid" ? (a > b ? -1 : a < b ? 1 : 0) : (a < b ? -1 : a > b ? 1 : 0));
    const live = resting.filter((order) => order.side === side && order.expiresAt > now).sort((a, b) => better(a.price, b.price));
    const wanted = targets.filter((quote) => quote.side === side).sort((a, b) => better(a.price, b.price));
    wanted.forEach((quote, rank) => {
      const order = live[rank];
      if (!order) { actions.push({ kind: "place", quote }); return; }
      const tolerance = (index * BigInt(2 + quote.rung * 2)) / 100_000n; // 0.2 bp at the touch … 2 bp deep
      const drift = order.price > quote.price ? order.price - quote.price : quote.price - order.price;
      if (drift > tolerance || order.expiresAt - now < refreshBeforeS) actions.push({ kind: "replace", key: order.key, quote });
    });
    for (const extra of live.slice(wanted.length)) actions.push({ kind: "cancel", key: extra.key });
  }
  // Expired leftovers still hold margin until cancelled.
  for (const order of resting) if (order.expiresAt <= now) actions.push({ kind: "cancel", key: order.key });
  return actions;
}

export interface Bundle { core: string; bookPages: string[]; seatShards: string[]; eventShards: string[]; oracleSnapshot: string }
export interface OrderInput { seatIndex: number; side: "bid" | "ask"; quantity: bigint; price: bigint; expiresAt: bigint; clientOrderId: bigint; postOnly?: boolean; immediateOrCancel?: boolean }

/** Execution metas, in program order (mirrors clients/stockstream v3ExecutionMetas). */
function executionAccounts(bundle: Bundle, authority: string) {
  return [
    ...[bundle.core, ...bundle.bookPages, ...bundle.seatShards, ...bundle.eventShards].map((value) => ({ address: address(value), role: AccountRole.WRITABLE })),
    { address: address(authority), role: AccountRole.READONLY_SIGNER },
    { address: address(bundle.oracleSnapshot), role: AccountRole.READONLY },
  ];
}

/** PlaceOrderV3 (opcode 3), byte-compatible with clients/stockstream placeOrderV3. */
export function placeOrderIx(bundle: Bundle, authority: string, order: OrderInput): Instruction {
  const data = new Uint8Array(54);
  const view = new DataView(data.buffer);
  data[0] = 3;
  data[1] = order.side === "bid" ? 0 : 1;
  data[2] = 0; // fixed-price tree
  data[3] = (order.postOnly ? 1 : 0) | (order.immediateOrCancel ? 2 : 0);
  view.setUint16(4, order.seatIndex, true);
  view.setBigUint64(6, order.quantity, true);
  view.setBigInt64(14, order.price, true);
  view.setBigUint64(22, order.expiresAt, true);
  view.setBigInt64(30, 0n, true);
  view.setBigUint64(38, order.clientOrderId, true);
  view.setBigUint64(46, 0n, true); // main-wallet action nonce
  return { programAddress: address(STOCKSTREAM_PROGRAM_ID), accounts: executionAccounts(bundle, authority), data };
}

/** ReplaceOrderV3 (opcode 33): atomically cancels `oldKey` and places the new order. */
export function replaceOrderIx(bundle: Bundle, authority: string, oldKey: bigint, order: OrderInput): Instruction {
  const place = placeOrderIx(bundle, authority, order).data as Uint8Array;
  const data = new Uint8Array(70);
  const view = new DataView(data.buffer);
  data[0] = 33;
  view.setBigUint64(1, oldKey & 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(9, oldKey >> 64n, true);
  data.set(place.subarray(1), 17);
  return { programAddress: address(STOCKSTREAM_PROGRAM_ID), accounts: executionAccounts(bundle, authority), data };
}

/** CancelOrderV3 (opcode 4), byte-compatible with clients/stockstream cancelOrderV3. */
export function cancelOrderIx(bundle: Bundle, authority: string, seatIndex: number, key: bigint): Instruction {
  const data = new Uint8Array(27);
  const view = new DataView(data.buffer);
  data[0] = 4;
  view.setUint16(1, seatIndex, true);
  view.setBigUint64(3, key & 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(11, key >> 64n, true);
  view.setBigUint64(19, 0n, true);
  return { programAddress: address(STOCKSTREAM_PROGRAM_ID), accounts: executionAccounts(bundle, authority), data };
}

/** CancelAllV3 (opcode 5), byte-compatible with clients/stockstream cancelAllV3. */
export function cancelAllIx(bundle: Bundle, authority: string, seatIndex: number, maxCancellations: number): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  data[0] = 5;
  view.setUint16(1, seatIndex, true);
  data[3] = maxCancellations;
  view.setBigUint64(4, 0n, true);
  return { programAddress: address(STOCKSTREAM_PROGRAM_ID), accounts: executionAccounts(bundle, authority), data };
}

