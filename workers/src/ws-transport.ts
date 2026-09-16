/** Priority 5, Section 2: concrete Solana JSON-RPC *pubsub* (WebSocket)
 * transports for both the L1 cluster and a MagicBlock ephemeral rollup.
 * `chain-transports.ts` already provides the HTTP JSON-RPC request/response
 * side (`getAccountInfo`, `getTransaction`, ...); this is the *subscription*
 * side of the same real Solana RPC protocol: `logsSubscribe`,
 * `accountSubscribe`, `signatureSubscribe` and their `*Unsubscribe`
 * counterparts, exactly as the cluster itself defines them (method names,
 * param shapes, and notification envelopes are not invented here).
 *
 * The WebSocket constructor is injected (`WebSocketFactory`), the same
 * dependency-injection pattern `chain-transports.ts` uses for `fetch`, so
 * tests can supply a fully in-memory mock server with no real networking
 * (see `ws-transport.test.ts`), and production code injects the real
 * global `WebSocket` (available as an outbound client in the Workers
 * runtime, not only as an inbound `WebSocketPair` acceptor -- see
 * `market-stream.ts` for the inbound side).
 */

export type WebSocketReadyState = 0 | 1 | 2 | 3;

/** The minimal surface this transport needs from a WebSocket-shaped
 * object. The real global `WebSocket` satisfies this; so does an
 * in-memory test double. */
export type WebSocketLikeEvent = { data: unknown } | { code: number; reason: string } | undefined;

export interface WebSocketLike {
  readonly readyState: WebSocketReadyState;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketLikeEvent) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ChainSource = "l1" | "er";
export type Commitment = "processed" | "confirmed" | "finalized";

/** Every notification this transport delivers carries this envelope,
 * regardless of subscription kind -- callers must never treat an `er`
 * event as L1-committed state (see `docs/magicblock.md`). */
export interface SourceMetadata {
  source: ChainSource;
  endpoint: string;
  slot?: number;
  signature?: string;
  commitment: Commitment;
  receivedAt: number;
}

export interface LogsNotification extends SourceMetadata {
  kind: "logs";
  err: unknown;
  logs: string[];
}
export interface AccountNotification extends SourceMetadata {
  kind: "account";
  pubkey: string;
  value: unknown;
}
export interface SignatureNotification extends SourceMetadata {
  kind: "signature";
  err: unknown;
}
export type ChainNotification = LogsNotification | AccountNotification | SignatureNotification;

export type LogsFilter = "all" | "allWithVotes" | { mentions: [string] };

interface PendingRequest {
  resolve: (id: number) => void;
  reject: (error: Error) => void;
  restore?: () => void;
}

interface ActiveSubscription {
  kind: "logs" | "account" | "signature";
  params: unknown[];
  handler: (notification: ChainNotification) => void;
  oneShot: boolean;
}

export interface TransportOptions {
  source: ChainSource;
  endpoint: string;
  factory: WebSocketFactory;
  /** Wall-clock source, injectable for deterministic tests. */
  now?: () => number;
  /** Base/cap for bounded exponential reconnect backoff, in ms. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** No message (of any kind, including our own heartbeat probe's
   * response) within this window means the connection is presumed dead
   * and is force-closed to trigger a reconnect. */
  staleTimeoutMs?: number;
  /** How often to probe liveness (a lightweight `getVersion` HTTP-less
   * RPC call over the same socket) when otherwise idle. */
  heartbeatIntervalMs?: number;
  onError?: (error: Error) => void;
}

const DEFAULTS = { baseBackoffMs: 250, maxBackoffMs: 30_000, staleTimeoutMs: 45_000, heartbeatIntervalMs: 15_000 };

/**
 * A single subscription-oriented connection to one Solana-RPC-compatible
 * WebSocket endpoint (either the L1 cluster or one MagicBlock ER
 * validator). Each chain gets its own instance and identity: this class
 * never multiplexes L1 and ER traffic over one connection, so a caller can
 * never mistake which chain an event came from.
 */
export class ChainWebSocketTransport {
  private readonly source: ChainSource;
  private readonly endpoint: string;
  private readonly factory: WebSocketFactory;
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly staleTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly onError: (error: Error) => void;

  private socket: WebSocketLike | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<number, ActiveSubscription>();
  private attempt = 0;
  private shuttingDown = false;
  private lastMessageAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(options: TransportOptions) {
    this.source = options.source;
    this.endpoint = options.endpoint;
    this.factory = options.factory;
    this.now = options.now ?? Date.now;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULTS.staleTimeoutMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.onError = options.onError ?? (() => {});
  }

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.shuttingDown = false;
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.factory(this.endpoint);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.attempt = 0;
        this.lastMessageAt = this.now();
        this.startHeartbeat();
        this.restoreSubscriptions();
        if (!settled) { settled = true; resolve(); }
      });
      socket.addEventListener("message", (event) => this.handleMessage((event as { data: unknown }).data));
      socket.addEventListener("error", () => this.onError(new Error(`${this.source} websocket error (${this.endpoint})`)));
      socket.addEventListener("close", () => {
        this.stopHeartbeat();
        this.socket = null;
        this.connectPromise = null;
        for (const request of this.pending.values()) request.reject(new Error("connection closed"));
        this.pending.clear();
        if (!settled) { settled = true; reject(new Error(`${this.source} websocket closed before opening`)); }
        if (!this.shuttingDown) this.scheduleReconnect();
      });
    });
    return this.connectPromise;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error: unknown) => this.onError(error instanceof Error ? error : new Error(String(error))));
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const idleFor = this.now() - this.lastMessageAt;
      if (idleFor > this.staleTimeoutMs) {
        this.socket?.close(4000, "stale connection");
        return;
      }
      if (idleFor > this.heartbeatIntervalMs) this.send("getVersion", []).catch(() => {});
    }, this.heartbeatIntervalMs);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private send(method: string, params: unknown[]): Promise<number> {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error(`${this.source} websocket not open`));
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.socket!.send(payload); } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(raw: unknown): void {
    this.lastMessageAt = this.now();
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as Record<string, unknown>;
    } catch {
      this.onError(new Error(`${this.source}: malformed websocket message`));
      return;
    }
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = message.error as { message?: string };
        request.reject(new Error(error.message ?? "RPC error"));
      } else {
        request.resolve(message.result as number);
      }
      return;
    }
    const method = message.method;
    if (typeof method !== "string" || !method.endsWith("Notification")) return;
    const params = message.params as { subscription?: number; result?: unknown } | undefined;
    if (!params || typeof params.subscription !== "number") return;
    const subscription = this.subscriptions.get(params.subscription);
    if (!subscription) return;
    const notification = this.toNotification(subscription, params.result);
    if (!notification) return;
    subscription.handler(notification);
    if (subscription.oneShot) this.subscriptions.delete(params.subscription);
  }

  private toNotification(subscription: ActiveSubscription, result: unknown): ChainNotification | null {
    const wrapped = result as { context?: { slot?: number }; value?: unknown } | undefined;
    const base: SourceMetadata = {
      source: this.source,
      endpoint: this.endpoint,
      slot: wrapped?.context?.slot,
      commitment: (subscription.params[1] as { commitment?: Commitment } | undefined)?.commitment ?? "confirmed",
      receivedAt: this.now(),
    };
    if (subscription.kind === "logs") {
      const value = wrapped?.value as { signature?: string; err: unknown; logs?: string[] } | undefined;
      if (!value) return null;
      return { ...base, kind: "logs", signature: value.signature, err: value.err, logs: value.logs ?? [] };
    }
    if (subscription.kind === "account") {
      return { ...base, kind: "account", pubkey: subscription.params[0] as string, value: wrapped?.value };
    }
    const value = wrapped?.value as { err: unknown } | "receivedSignature" | undefined;
    return { ...base, kind: "signature", signature: subscription.params[0] as string, err: value === "receivedSignature" ? undefined : value?.err };
  }

  /** Subscribes to `logsSubscribe`. Never fires until `connect()` has
   * resolved once, but survives every subsequent reconnect: the exact same
   * subscription is automatically re-issued (see `restoreSubscriptions`). */
  async subscribeLogs(filter: LogsFilter, commitment: Commitment, handler: (n: LogsNotification) => void): Promise<number> {
    return this.subscribe("logs", "logsSubscribe", [filter, { commitment }], handler as (n: ChainNotification) => void, false);
  }
  async subscribeAccount(pubkey: string, commitment: Commitment, handler: (n: AccountNotification) => void): Promise<number> {
    return this.subscribe("account", "accountSubscribe", [pubkey, { encoding: "base64", commitment }], handler as (n: ChainNotification) => void, false);
  }
  /** Signature subscriptions are one-shot on a real Solana cluster: the
   * server fires at most one notification per subscription and implicitly
   * drops it afterward, so this transport does too (and will not restore
   * it after a reconnect once it has already fired). */
  async subscribeSignature(signature: string, commitment: Commitment, handler: (n: SignatureNotification) => void): Promise<number> {
    return this.subscribe("signature", "signatureSubscribe", [signature, { commitment }], handler as (n: ChainNotification) => void, true);
  }

  private async subscribe(kind: ActiveSubscription["kind"], method: string, params: unknown[], handler: (n: ChainNotification) => void, oneShot: boolean): Promise<number> {
    const id = await this.send(method, params);
    this.subscriptions.set(id, { kind, params, handler, oneShot });
    return id;
  }

  async unsubscribe(subscriptionId: number): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    this.subscriptions.delete(subscriptionId);
    const method = `${subscription.kind}Unsubscribe`;
    const result = await this.send(method, [subscriptionId]);
    return Boolean(result);
  }

  private restoreSubscriptions(): void {
    const previous = new Map(this.subscriptions);
    this.subscriptions.clear();
    for (const [oldId, subscription] of previous) {
      if (subscription.oneShot) continue; // already fired, or would race a fresh signature's lifecycle
      const method = `${subscription.kind}Subscribe`;
      this.send(method, subscription.params)
        .then((newId) => this.subscriptions.set(newId, subscription))
        .catch((error: unknown) => this.onError(error instanceof Error ? error : new Error(String(error))));
      void oldId;
    }
  }

  /** Graceful shutdown: best-effort unsubscribe from everything, stop all
   * timers, and close the socket without triggering a reconnect. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    const ids = [...this.subscriptions.keys()];
    await Promise.all(ids.map((id) => this.unsubscribe(id).catch(() => {})));
    this.socket?.close(1000, "shutdown");
    this.socket = null;
    this.connectPromise = null;
  }
}
