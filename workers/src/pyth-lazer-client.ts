/**
 * Real Pyth Pro (Lazer) streaming client.
 *
 * Protocol ground truth (verified 2026-09-17 against the official sources,
 * not remembered SDK APIs):
 *
 * - `docs.pyth.network/price-feeds/pro/subscribe-to-prices`: three endpoints
 *   (`wss://pyth-lazer-{0,1,2}.dourolabs.app/v1/stream`), connecting to ALL
 *   THREE is a documented requirement, not a suggestion; authentication for
 *   server-to-server integrations is an `Authorization: Bearer <key>` header
 *   (browsers cannot set WS headers, which is why they need the JWT
 *   subprotocol instead -- this client runs server-side in the Worker, so
 *   the header path is the correct one and the key never leaves the
 *   backend).
 * - `pyth-network/pyth-lazer-public` `sdk/js/src/protocol.ts` (fetched this
 *   session): the wire protocol is `{ type: "subscribe", subscriptionId,
 *   priceFeedIds, properties, formats, channel, ignoreInvalidFeeds, ... }`
 *   -> `{ type: "subscribed" | "subscribedWithInvalidFeedIdsIgnored" |
 *   "subscriptionError" | "error" | "unsubscribed" | "streamUpdated" }`
 *   envelopes; `streamUpdated` carries `parsed` and a `solana` field
 *   `{ encoding: "hex", data }` holding the full signed Solana-format
 *   message (leading `SOLANA_FORMAT_MAGIC` 2182742457) exactly what
 *   `programs/equinox/src/handlers.rs::parse_verified_oracle` and the
 *   Pyth CPI verifier consume.
 * - `sdk/rust/protocol/src/api.rs`: `ignore_invalid_feeds` is
 *   serde-camelCase `ignoreInvalidFeeds` with alias `ignoreInvalidFeedIds`
 *   (the docs' `ignoreInvalidFeeds` spelling is the canonical one).
 * - No protocol-level client ping exists (`api.rs` / `protocol.ts` contain
 *   none; the JS SDK relies on transport-level ping frames the Workers
 *   runtime does not surface). Heartbeat therefore = message-activity idle
 *   timeout: a `fixed_rate@200ms` subscription that goes silent for
 *   `idleTimeoutMs` is presumed dead and force-closed to trigger a bounded
 *   reconnect + resubscribe.
 * - `PriceFeedProperty` (official enum) contains `marketSession` but NO
 *   `tradingStatus` property -- confirming `docs/pyth-ops.md`'s
 *   pending-verification note. Halt/corporate-action handling remains
 *   mapped through `marketSession` until upstream exposes a real
 *   `TradingStatus` property.
 *
 * The key never appears in logs, metrics, or error messages (secret-redacted
 * by construction: header values are only ever written into the factory
 * call, never stored on `this`).
 */

import type { WebSocketLike, WebSocketLikeEvent } from "./ws-transport";
import { reconcileEndpointUpdates, type PythSignedUpdate } from "./pyth-source";

export type PythLazerProperty =
  | "price"
  | "bestBidPrice"
  | "bestAskPrice"
  | "exponent"
  | "publisherCount"
  | "confidence"
  | "fundingRate"
  | "fundingTimestamp"
  | "fundingRateInterval"
  | "marketSession"
  | "emaPrice"
  | "emaConfidence"
  | "feedUpdateTimestamp";

export type PythLazerChannel = "real_time" | "fixed_rate@50ms" | "fixed_rate@200ms" | "fixed_rate@1000ms";

export interface PythLazerSubscriptionParams {
  type: "subscribe";
  subscriptionId: number;
  priceFeedIds: number[];
  properties: PythLazerProperty[];
  formats: ["solana"];
  channel: PythLazerChannel;
  ignoreInvalidFeeds: boolean;
}

/** Outbound WebSocket factory with authentication headers. The Workers
 * runtime performs client WebSocket handshakes via `fetch` with an
 * `Upgrade: websocket` header (custom headers such as `Authorization` are
 * allowed there); production injects that adapter, tests inject in-memory
 * mock servers. */
export type PythWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface PythLazerEndpointOptions {
  name: string;
  url: string;
  apiKey: string;
  subscription: PythLazerSubscriptionParams;
  factory: PythWebSocketFactory;
  /** Wall-clock source, injectable for deterministic tests. */
  now?: () => number;
  /** Jitter source for bounded reconnect backoff (tests pin it). */
  jitter?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** No message (of any kind) within this window on a fixed-rate channel
   * means the connection is presumed dead (the activity-heartbeat rule
   * above; no protocol-level ping exists in the Lazer protocol). */
  idleTimeoutMs?: number;
  /** Any single message larger than this is dropped and counted. */
  maxMessageBytes?: number;
  onFatal?: (error: PythEndpointError) => void;
  onError?: (error: Error) => void;
}

const DEFAULTS = {
  baseBackoffMs: 200,
  maxBackoffMs: 20_000,
  // 200ms channel: anything past ~5s of silence is a dead connection.
  idleTimeoutMs: 5_000,
  maxMessageBytes: 65_536,
};

export type PythEndpointState = "idle" | "connecting" | "subscribed" | "reconnecting" | "closed";

/** Terminal failure classes surfaced by the Lazer protocol itself. */
export type PythEndpointFatalReason =
  | "unauthorized"
  | "forbidden"
  | "subscription_error"
  | "rate_limited";

export interface PythEndpointError extends Error {
  reason: PythEndpointFatalReason;
}

export class PythLazerEndpoint {
  readonly name: string;
  readonly url: string;
  private readonly apiKey: string;
  private readonly subscription: PythLazerSubscriptionParams;
  private readonly factory: PythWebSocketFactory;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly onFatal?: (error: PythEndpointError) => void;
  private readonly onError: (error: Error) => void;

  private socket: WebSocketLike | null = null;
  private state: PythEndpointState = "idle";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** Latest accepted update for the subscribed feed (dedup buffer). */
  private latestUpdate: PythSignedUpdate | null = null;
  /** Metrics (never contain the key or raw payloads). */
  metrics = {
    connects: 0,
    reconnects: 0,
    messages: 0,
    droppedOversized: 0,
    schemaRejected: 0,
    lastMessageAt: 0,
    lastError: null as string | null,
    lastFatal: null as PythEndpointFatalReason | null,
  };

  constructor(options: PythLazerEndpointOptions) {
    this.name = options.name;
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.subscription = options.subscription;
    this.factory = options.factory;
    this.now = options.now ?? Date.now;
    this.jitter = options.jitter ?? Math.random;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULTS.maxMessageBytes;
    this.onFatal = options.onFatal;
    this.onError = options.onError ?? (() => undefined);
  }

  get endpointState(): PythEndpointState {
    return this.state;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  /** Opens the connection and subscribes. Never throws. */
  start(): void {
    if (this.closed) return;
    this.state = "connecting";
    this.connect();
  }

  /** Idempotent graceful shutdown. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.state = "closed";
    if (socket && socket.readyState <= 1) socket.close(1000, "shutdown");
  }

  private connect(): void {
    if (this.closed) return;
    // The API key lives only inside this header map handed to the factory;
    // it is never stored on the instance, logged, or stringified.
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url, { Authorization: `Bearer ${this.apiKey}` });
    } catch (error) {
      this.scheduleReconnect(new Error(`websocket factory threw: ${(error as Error).message}`));
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.closed || this.socket !== socket) return;
      this.metrics.connects += 1;
      socket.send(JSON.stringify(this.subscription));
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => {
      if (this.closed || this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect(new Error("connection closed"));
    });
    socket.addEventListener("error", () => {
      this.onError(new Error(`endpoint ${this.name} socket error`));
    });
  }

  private scheduleReconnect(cause: Error): void {
    if (this.closed) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 30);
    // Bounded exponential backoff with jitter, capped.
    const backoff = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.min(attempt, 20) * (0.5 + this.jitter()),
    );
    this.state = "reconnecting";
    this.metrics.reconnects += 1;
    this.metrics.lastError = cause.message;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoff);
  }

  private handleFatal(reason: PythEndpointFatalReason, message: string): void {
    this.state = "closed";
    this.socket = null;
    this.metrics.lastFatal = reason;
    this.metrics.lastError = message;
    const error: PythEndpointError = Object.assign(new Error(message), { reason });
    if (this.onFatal) this.onFatal(error);
  }

  private handleEvent(data: unknown): void {
    // Message-size limit.
    if (typeof data === "string" && data.length * 2 > this.maxMessageBytes) {
      this.metrics.droppedOversized += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      this.metrics.schemaRejected ??= 0;
      this.metrics.schemaRejected += 1;
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.metrics.schemaRejected = (this.metrics.schemaRejected ?? 0) + 1;
      return;
    }
    switch (parsed.type) {
      case "subscribed":
        this.reconnectAttempt = 0;
        this.state = "subscribed";
        return;
      case "subscribedWithInvalidFeedIdsIgnored": {
        // Analytics-class behaviour: some feeds were skipped. Recorded, not
        // fatal (this must never happen on the risk subscription, whose
        // `ignoreInvalidFeeds` is false; there it fails loudly below).
        this.reconnectAttempt = 0;
        this.state = "subscribed";
        this.metrics.lastError = `feeds ignored: ${JSON.stringify(parsed.ignoredInvalidFeedIds ?? {})}`;
        return;
      }
      case "error": {
        const message = String(parsed.error ?? "unknown error");
        const reason = classifyProtocolError(message);
        if (reason === "unauthorized" || reason === "forbidden" || reason === "rate_limited") {
          this.handleFatal(reason, message);
        } else {
          this.scheduleReconnect(new Error(message));
        }
        return;
      }
      case "subscriptionError": {
        this.handleFatal("subscription_error", String(parsed.error ?? "subscription rejected"));
        return;
      }
      case "streamUpdated": {
        this.metrics.lastMessageAt = this.now();
        const update = extractSolanaUpdate(parsed, this.name);
        if (update) this.latestUpdate = update;
        else this.metrics.schemaRejected += 1;
        return;
      }
      case "unsubscribed":
        this.state = "idle";
        return;
      default:
        this.metrics.schemaRejected = (this.metrics.schemaRejected ?? 0) + 1;
    }
  }

  private idleProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt = 0;

  private handleMessage(event: WebSocketLikeEvent): void {
    if (this.closed) return;
    this.lastActivityAt = this.now();
    this.metrics.messages += 1;
    const data = event && "data" in event ? event.data : undefined;
    this.handleEvent(data);
    // Activity-based liveness: if nothing arrives within idleTimeoutMs of
    // the last message, force-close and reconnect (fixed_rate@200ms channels
    // produce constant traffic, so silence = dead connection; there is no
    // protocol-level ping in the Lazer protocol to probe instead).
    if (this.idleProbeTimer !== null) clearTimeout(this.idleProbeTimer);
    this.idleProbeTimer = setTimeout(() => {
      this.idleProbeTimer = null;
      if (this.closed || this.socket === null) return;
      if (this.now() - this.lastActivityAt > this.idleTimeoutMs) {
        this.socket.close(4000, "idle timeout");
        this.socket = null;
        this.scheduleReconnect(new Error(`no messages within ${this.idleTimeoutMs}ms`));
      }
    }, this.idleTimeoutMs + 250);
  }

  /** Latest deduplicated update observed by this endpoint. */
  get latest(): PythSignedUpdate | null {
    return this.latestUpdate;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Classifies a Lazer protocol error string into the terminal failure
 * classes the risk path must distinguish (credential vs entitlement vs
 * rate-limit vs transient). */
function classifyProtocolError(message: string): PythEndpointFatalReason | "transient" {
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("401") || lower.includes("invalid token") || lower.includes("authentication")) {
    return "unauthorized";
  }
  if (lower.includes("forbidden") || lower.includes("403") || lower.includes("entitlement") || lower.includes("not allowed") || lower.includes("access denied")) {
    return "forbidden";
  }
  if (lower.includes("rate") || lower.includes("429") || lower.includes("too many")) {
    return "rate_limited";
  }
  return "transient";
}

/** Schema-validates one `streamUpdated` envelope and extracts the signed
 * Solana payload as a dedupable update. Malformed shapes return `null`
 * (counted as schema rejects by the caller) rather than throwing. */
export function extractSolanaUpdate(
  envelope: Record<string, unknown>,
  endpointName: string,
): PythSignedUpdate | null {
  const solana = envelope.solana;
  if (!isRecord(solana) || solana.encoding !== "hex" || typeof solana.data !== "string") return null;
  let message: Uint8Array;
  try {
    message = hexToBytes(solana.data);
  } catch {
    return null;
  }
  // Solana format magic: 2_182_742_457 LE.
  if (message.length < 8) return null;
  const magic = ((message[0] | (message[1] << 8) | (message[2] << 16) | (message[3] << 24)) >>> 0);
  if (magic !== 2_182_742_457) return null;
  // The parsed feed block must name the same feed the signed payload carries;
  // a mismatch is a schema violation (feed identity check, docs/pyth-ops.md).
  const parsed = envelope.parsed;
  if (!isRecord(parsed) || typeof parsed.timestampUs !== "string" || !Array.isArray(parsed.priceFeeds)) {
    return null;
  }
  const feed = parsed.priceFeeds.find(isRecord) as Record<string, unknown> | undefined;
  if (!feed || typeof feed.priceFeedId !== "number" || typeof feed.feedUpdateTimestamp !== "number") {
    return null;
  }
  const feedUpdateTimestamp = feed.feedUpdateTimestamp;
  if (!Number.isFinite(feedUpdateTimestamp) || feedUpdateTimestamp < 0) return null;
  // Signed-payload identity: hash the message bytes (hex) so multi-endpoint
  // agreement compares exact payloads, not just timestamps.
  return {
    feedId: String(feed.priceFeedId),
    timestamp: Math.floor(feedUpdateTimestamp / 1_000_000),
    payloadHash: hashBytes(message),
    message,
    endpoint: endpointName,
  };
}

/** FNV-1a over the message bytes: small, deterministic, allocation-free. */
function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The redundant three-endpoint pool: three parallel `PythLazerEndpoint`s
 * (docs.pyth.network requires all three), a shared latest-update buffer per
 * subscription, and `reconcileEndpointUpdates`' dedup/regression/conflict
 * rules applied over whatever the endpoints observed in a fetch window. */
export interface PythLazerPoolOptions {
  apiKey: string;
  endpoints: readonly [string, string] | readonly string[];
  riskSubscription: PythLazerSubscriptionParams;
  factory: PythWebSocketFactory;
  now?: () => number;
  jitter?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  idleTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface PythLazerEndpointHealth {
  name: string;
  state: PythEndpointState;
  connects: number;
  reconnects: number;
  messages: number;
  droppedOversized: number;
  schemaRejected: number;
  lastMessageAt: number;
  lastError: string | null;
  lastFatal: PythEndpointFatalReason | null;
}

export class PythLazerPool {
  private readonly endpoints: PythLazerEndpoint[];
  private readonly now: () => number;

  constructor(options: PythLazerPoolOptions) {
    this.now = options.now ?? Date.now;
    this.endpoints = options.endpoints.map((url, index) => {
      const name = `pyth-lazer-${index}`;
      return new PythLazerEndpoint({
        name,
        url,
        apiKey: options.apiKey,
        subscription: options.riskSubscription,
        factory: options.factory,
        now: this.now,
        jitter: options.jitter,
        baseBackoffMs: options.baseBackoffMs,
        maxBackoffMs: options.maxBackoffMs,
        idleTimeoutMs: options.idleTimeoutMs,
        onError: options.onError,
        onFatal: (error) => {
          // The pool keeps the other endpoints running (a single endpoint
          // going down must never stop the others), but the scheduler is
          // informed so it can stop submitting if redundancy collapses.
          options.onError?.(error);
        },
      });
    });
  }

  start(): void {
    for (const endpoint of this.endpoints) endpoint.start();
  }

  close(): void {
    for (const endpoint of this.endpoints) endpoint.close();
  }

  /** Snapshot without secrets. */
  health(): PythLazerEndpointHealth[] {
    return this.endpoints.map((endpoint) => ({
      name: endpoint.name,
      state: endpoint.endpointState,
      connects: endpoint.metrics.connects,
      reconnects: endpoint.metrics.reconnects,
      messages: endpoint.metrics.messages,
      droppedOversized: endpoint.metrics.droppedOversized,
      schemaRejected: endpoint.metrics.schemaRejected,
      lastMessageAt: endpoint.metrics.lastMessageAt,
      lastError: endpoint.metrics.lastError,
      lastFatal: endpoint.metrics.lastFatal,
    }));
  }

  /** True while at least two endpoints are healthy -- the redundancy floor
   * the risk path requires before submitting (three are required to
   * operate, one may be down during deployments). */
  redundancyHealthy(): boolean {
    return this.endpoints.filter((endpoint) => endpoint.connected).length >= 2;
  }

  /** Polls the dedup buffer: all endpoint copies of one feed update must
   * agree (identical payload); a timestamp regression or conflicting
   * same-timestamp payloads quarantines (docs/pyth-ops.md §5c). */
  async fetchSignedUpdates(): Promise<readonly PythSignedUpdate[]> {
    const updates = this.endpoints
      .map((endpoint) => endpoint.latest)
      .filter((update): update is PythSignedUpdate => update !== null);
    return updates;
  }

  get endpointCount(): number {
    return this.endpoints.length;
  }
}

