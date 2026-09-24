"use client";

import { useEffect, useState } from "react";
import { deriveV3ExecutionAccounts } from "@/clients/equinox/src";
import deployment from "@/config/equinox-deployment.json";
import { annotateBookTrees, decodeV3BookPage, decodeV3EventShard, decodeV3SeatShard, type V3BookPageState } from "../../workers/src/v3-market-state";

export interface BookLevel { price: number; size: number }
export interface Trade { sequence: string; price: number; size: number; makerSeat: number; takerSeat: number; time: number }
export interface SeatPosition {
  shard: number; slot: number; trader: string; availableCollateral: string; reservedMargin: string;
  basePosition: string; quoteEntryValue: string; realizedPnl: string; openOrderCount: number; liquidationState: number;
}
export type BookStatus = "loading" | "live" | "empty" | "stale" | "unavailable";

/** A resting fixed-price order, with its owning seat (for "my open orders"). */
export interface RestingOrderView { owner: number; orderKey: bigint; side: "bid" | "ask"; price: bigint; quantity: bigint; expiresAt: bigint; postOnly: boolean; reduceOnly: boolean }
export interface V3Book {
  bids: BookLevel[]; asks: BookLevel[]; trades: Trade[]; positions: SeatPosition[]; orders: RestingOrderView[];
  status: BookStatus; updatedAt: number | null; domain: "er" | "l1";
}

type Int = string | bigint;
interface RawNode { tag?: number; side?: number; quantity?: Int; priceOrOffset?: Int; expiresAt?: Int; tree?: string; pegLimit?: Int }
interface RawRecord { kind?: number; sequence?: Int; timestamp?: Int; payload?: ArrayLike<number> }
interface RawAggregate {
  eventShards?: { records?: readonly (RawRecord | null)[] }[];
}

/** V3 prices use the oracle's raw scale (TSLA exponent −5). */
export const PRICE_SCALE = 1e5;
const FILL_KINDS = new Set([203, 204]); // OrderPartiallyFilled, OrderFilled (programs/equinox/src/events.rs)

/** Resting leaves → price levels. Oracle-pegged orders price at index + offset (capped by their limit). */
export function levelsFrom(nodes: readonly RawNode[], bid: boolean, oracleRaw: bigint, nowSec: bigint): BookLevel[] {
  const bySide = new Map<number, number>();
  for (const node of nodes) {
    if (node.tag !== 2 || !node.quantity || !node.priceOrOffset) continue;
    if (node.expiresAt && BigInt(node.expiresAt) <= nowSec) continue;
    let price = BigInt(node.priceOrOffset);
    if (node.tree === "oracle-pegged") {
      price += oracleRaw;
      const limit = node.pegLimit ? BigInt(node.pegLimit) : 0n;
      if (limit <= 0n || (bid ? price > limit : price < limit)) continue;
    }
    const quantity = Number(node.quantity);
    if (price <= 0n || quantity <= 0) continue;
    const key = Number(price) / PRICE_SCALE;
    bySide.set(key, (bySide.get(key) ?? 0) + quantity);
  }
  return [...bySide].map(([price, size]) => ({ price, size })).sort((a, b) => (bid ? b.price - a.price : a.price - b.price));
}

/** Fill events: payload = maker seat u32 · taker seat u32 · price i64 · quantity u64 · fill sequence u64. */
export function tradesFrom(shards: RawAggregate["eventShards"]): Trade[] {
  const trades: Trade[] = [];
  for (const record of (shards ?? []).flatMap((shard) => shard.records ?? [])) {
    if (!record || !FILL_KINDS.has(record.kind ?? 0) || !record.payload || record.payload.length < 24) continue;
    const view = new DataView(Uint8Array.from(record.payload).buffer);
    trades.push({
      sequence: String(record.sequence ?? "0"),
      makerSeat: view.getUint32(0, true), takerSeat: view.getUint32(4, true),
      price: Number(view.getBigInt64(8, true)) / PRICE_SCALE, size: Number(view.getBigUint64(16, true)),
      time: Number(record.timestamp ?? 0),
    });
  }
  return trades.sort((a, b) => (BigInt(b.sequence) > BigInt(a.sequence) ? 1 : -1)).slice(0, 50);
}

const EMPTY: Omit<V3Book, "status" | "domain"> = { bids: [], asks: [], trades: [], positions: [], orders: [], updatedAt: null };
const ER_RPC = deployment.magicBlock.rpc;
const L1_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet";
/** One failed read is not an outage; only a silent feed for this long is. */
const STALE_AFTER_MS = 20_000;
const REQUOTE_GAP_MS = 2_500;
const FIRST_READ_TIMEOUT_MS = 8_000;
const FALLBACK_READ_DELAY_MS = 3_500;

function decodeBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Decodes the 18 book pages, 4 seat shards and 4 event shards into levels, fills and seats. */
export function decodeBundle(pages: readonly (Uint8Array | null)[], seats: readonly (Uint8Array | null)[], events: readonly (Uint8Array | null)[], nowSec: bigint) {
  const decoded = pages.map((bytes) => (bytes ? decodeV3BookPage(bytes) : null));
  if (decoded.some((page) => !page) || !annotateBookTrees(decoded as V3BookPageState[])) return null;
  const leaves = (decoded as V3BookPageState[]).flatMap((page) => page.nodes).filter((node) => node.tag === 2);
  // Oracle-pegged leaves need the live index; the book shows fixed-price liquidity.
  const fixed = leaves.filter((node) => node.tree !== "oracle-pegged");
  const positions = seats.flatMap((bytes) => (bytes ? decodeV3SeatShard(bytes)?.positions ?? [] : [])).map((p) => ({
    shard: p.shard, slot: p.slot, trader: p.trader, availableCollateral: String(p.availableCollateral), reservedMargin: String(p.reservedMargin),
    basePosition: String(p.basePosition), quoteEntryValue: String(p.quoteEntryValue), realizedPnl: String(p.realizedPnl),
    openOrderCount: p.openOrderCount, liquidationState: p.liquidationState,
  }));
  return {
    bids: levelsFrom(fixed.filter((node) => node.side === 0), true, 0n, nowSec),
    asks: levelsFrom(fixed.filter((node) => node.side === 1), false, 0n, nowSec),
    trades: tradesFrom(events.map((bytes) => ({ records: bytes ? decodeV3EventShard(bytes)?.records ?? [] : [] }))),
    positions,
    orders: fixed.filter((node) => node.expiresAt! > nowSec && node.quantity! > 0n).map((node): RestingOrderView => ({
      owner: node.owner!, orderKey: node.key, side: node.side === 0 ? "bid" : "ask", price: node.priceOrOffset!, quantity: node.quantity!,
      expiresAt: node.expiresAt!, postOnly: !!node.postOnly, reduceOnly: !!node.reduceOnly,
    })),
  };
}

interface AggregateNode extends RawNode {
  owner?: number;
  key?: Int;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

interface AggregateBookResponse {
  completeExecutionState?: boolean;
  core?: { delegationStatus?: number };
  orderBook?: { bids?: AggregateNode[]; asks?: AggregateNode[] };
  positions?: SeatPosition[];
  eventShards?: RawAggregate["eventShards"];
}

/** The market API's complete, single-domain V3 snapshot is a read fallback
 * when a visitor's browser cannot reach MagicBlock RPC directly. */
function bookFromAggregate(value: AggregateBookResponse, domain: "er" | "l1") {
  const delegationStatus = value.core?.delegationStatus;
  const correctDomain = domain === "er" ? delegationStatus === 1 || delegationStatus === 2 : delegationStatus === 0 || delegationStatus === 3;
  if (!value.completeExecutionState || !correctDomain || !Array.isArray(value.orderBook?.bids) || !Array.isArray(value.orderBook?.asks) || !Array.isArray(value.positions) || !Array.isArray(value.eventShards)) return null;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const fixed = [...value.orderBook.bids, ...value.orderBook.asks].filter((node) => node.tag === 2 && node.tree !== "oracle-pegged");
  const orders: RestingOrderView[] = [];
  for (const node of fixed) {
    if (node.owner === undefined || node.key === undefined || node.expiresAt === undefined || node.quantity === undefined || node.priceOrOffset === undefined || node.side === undefined) return null;
    if (BigInt(node.expiresAt) <= nowSec || BigInt(node.quantity) <= 0n) continue;
    orders.push({
      owner: node.owner, orderKey: BigInt(node.key), side: node.side === 0 ? "bid" : "ask",
      price: BigInt(node.priceOrOffset), quantity: BigInt(node.quantity), expiresAt: BigInt(node.expiresAt),
      postOnly: !!node.postOnly, reduceOnly: !!node.reduceOnly,
    });
  }
  return {
    bids: levelsFrom(fixed.filter((node) => node.side === 0), true, 0n, nowSec),
    asks: levelsFrom(fixed.filter((node) => node.side === 1), false, 0n, nowSec),
    trades: tradesFrom(value.eventShards),
    positions: value.positions,
    orders,
  };
}

/** Live V3 book straight from the chain that owns it: the MagicBlock rollup
 * while delegated (websocket account pushes, so every fill and quote shows
 * up as it happens), Solana L1 otherwise. Reads bypass the market API, so
 * the book never waits on the Worker. */
export function useV3Book(marketApiUrl: string | undefined, core: string | undefined, delegated: boolean | null): V3Book {
  // Until the indexer says where the market lives, read nothing: the frozen
  // L1 copy of a delegated market would flash an empty book.
  const domain: "er" | "l1" | null = delegated === null ? null : delegated ? "er" : "l1";
  const [book, setBook] = useState<V3Book>({ ...EMPTY, status: core ? "loading" : "unavailable", domain: domain ?? "er" });
  const [sourceTimedOut, setSourceTimedOut] = useState(false);

  useEffect(() => {
    if (!core || domain) return;
    const timer = window.setTimeout(() => setSourceTimedOut(true), FIRST_READ_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [core, domain]);

  useEffect(() => {
    if (!core || !domain) return;
    const accounts = deriveV3ExecutionAccounts(core, core);
    const keys = [...accounts.bookPages, ...accounts.seatShards, ...accounts.eventShards].map(String);
    const data: (Uint8Array | null)[] = keys.map(() => null);
    const rpc = domain === "er" ? ER_RPC : L1_RPC;
    let stopped = false;
    let lastGood = 0;
    let scheduled = false;
    let snapshotPending = false;

    const fallbackSnapshot = async () => {
      if (!marketApiUrl || stopped || lastGood > 0) return;
      try {
        const response = await fetch(`${marketApiUrl}/v1/v3/markets/${core}?domain=${domain}`, { signal: AbortSignal.timeout(FIRST_READ_TIMEOUT_MS) });
        if (!response.ok) return;
        const aggregate = await response.json() as AggregateBookResponse;
        if (stopped || lastGood > 0) return;
        const decoded = bookFromAggregate(aggregate, domain);
        if (!decoded) return;
        lastGood = Date.now();
        setBook({ ...decoded, status: decoded.bids.length || decoded.asks.length ? "live" : "empty", updatedAt: lastGood, domain });
      } catch { /* Direct RPC keeps retrying; the fallback is best effort. */ }
    };
    const fallbackTimer = window.setTimeout(() => void fallbackSnapshot(), FALLBACK_READ_DELAY_MS);

    const markUnavailable = () => {
      if (stopped) return;
      setBook((previous) => ({
        ...previous, domain,
        status: previous.updatedAt ? (Date.now() - previous.updatedAt > STALE_AFTER_MS ? "stale" : previous.status) : "unavailable",
      }));
    };

    let lastQuotedAt = 0;
    const publish = () => {
      scheduled = false;
      if (stopped) return false;
      let decoded;
      try {
        decoded = decodeBundle(data.slice(0, 18), data.slice(18, 22), data.slice(22, 26), BigInt(Math.floor(Date.now() / 1000)));
      } catch {
        markUnavailable();
        return false;
      }
      if (!decoded) return false;
      lastGood = Date.now();
      const quoted = decoded.bids.length > 0 || decoded.asks.length > 0;
      // A market maker requotes by cancel-then-place: hold the last levels
      // through that sub-second gap instead of flashing an empty book.
      if (!quoted && lastGood - lastQuotedAt < REQUOTE_GAP_MS) { setTimeout(schedule, REQUOTE_GAP_MS); return true; }
      if (quoted) lastQuotedAt = lastGood;
      setBook({ ...decoded, status: decoded.bids.length || decoded.asks.length ? "live" : "empty", updatedAt: lastGood, domain });
      return true;
    };
    // Coalesce bursts of account pushes into one render per frame.
    const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(publish); } };

    const snapshot = async () => {
      if (snapshotPending) return;
      snapshotPending = true;
      try {
        const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(FIRST_READ_TIMEOUT_MS), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64", commitment: "confirmed" }] }) });
        if (!response.ok) throw new Error("book RPC unavailable");
        const body = await response.json() as { result?: { value: ({ data: [string, string] } | null)[] } };
        const values = body.result?.value;
        if (!values || values.length !== keys.length || stopped) throw new Error("incomplete book snapshot");
        values.forEach((value, index) => { data[index] = value ? decodeBase64(value.data[0]) : null; });
        if (!publish()) markUnavailable();
      } catch {
        markUnavailable();
      } finally {
        snapshotPending = false;
      }
    };
    void snapshot();

    // Push updates in the rollup; a gentle poll keeps both domains honest if the socket drops.
    let socket: WebSocket | null = null;
    if (domain === "er") {
      socket = new WebSocket(rpc.replace(/^http/, "ws"));
      const subscriptions = new Map<number, number>();
      socket.onopen = () => {
        for (const [index, key] of keys.entries()) {
          if (socket?.readyState !== WebSocket.OPEN) break;
          try {
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "accountSubscribe", params: [key, { encoding: "base64", commitment: "processed" }] }));
          } catch { break; }
        }
      };
      socket.onmessage = (message) => {
        const body = JSON.parse(message.data as string) as { id?: number; result?: number; params?: { subscription: number; result: { value: { data: [string, string] } | null } } };
        if (typeof body.id === "number" && typeof body.result === "number") { subscriptions.set(body.result, body.id - 1); return; }
        const index = body.params ? subscriptions.get(body.params.subscription) : undefined;
        if (index === undefined || !body.params) return;
        data[index] = body.params.result.value ? decodeBase64(body.params.result.value.data[0]) : null;
        schedule();
      };
    }
    const timer = setInterval(() => {
      if (document.hidden) return;
      // With a live socket, re-snapshot only if pushes went quiet.
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastGood < 10_000) return;
      void snapshot();
    }, domain === "er" ? 1_000 : 15_000);
    return () => { stopped = true; clearTimeout(fallbackTimer); clearInterval(timer); socket?.close(); };
  }, [core, domain, marketApiUrl]);

  if (!core) return { ...EMPTY, status: "unavailable", domain: domain ?? "er" };
  // Unknown domain, or a switch whose first read has not landed yet: still loading.
  if (!domain || book.domain !== domain) return { ...EMPTY, status: !domain && sourceTimedOut ? "unavailable" : "loading", domain: domain ?? "er" };
  return book;
}
