import { describe, expect, it, vi } from "vitest";
import { ChainWebSocketTransport, type ChainNotification, type WebSocketLike, type WebSocketLikeEvent, type WebSocketReadyState } from "./ws-transport";

type Listener = (event: WebSocketLikeEvent) => void;

/** A fully in-memory Solana-pubsub-shaped mock socket: no real networking.
 * Tests drive it by inspecting `sent` (the raw JSON-RPC requests the
 * transport under test issued) and calling `respond`/`notify`/`open`/
 * `serverClose` to simulate the other end of the wire. */
class FakeSocket implements WebSocketLike {
  readyState: WebSocketReadyState = 0;
  sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };
  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void { (this.listeners[type] ??= []).push(listener); }
  private emit(type: string, event?: WebSocketLikeEvent): void { for (const listener of [...this.listeners[type]]) listener(event); }
  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = ""): void { if (this.readyState === 3) return; this.readyState = 3; this.emit("close", { code, reason }); }
  open(): void { this.readyState = 1; this.emit("open"); }
  message(payload: unknown): void { this.emit("message", { data: JSON.stringify(payload) }); }
  raw(data: string): void { this.emit("message", { data }); }
  serverClose(code = 1006, reason = "server closed"): void { this.close(code, reason); }
  lastRequest(): { id: number; method: string; params: unknown[] } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
  respondToLast(result: unknown): void { this.message({ jsonrpc: "2.0", id: this.lastRequest().id, result }); }
  errorToLast(message: string): void { this.message({ jsonrpc: "2.0", id: this.lastRequest().id, error: { message } }); }
  notify(method: string, subscription: number, result: unknown): void { this.message({ jsonrpc: "2.0", method, params: { subscription, result } }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const factory = (): FakeSocket => { const s = new FakeSocket(); sockets.push(s); return s; };
  const errors: Error[] = [];
  const transport = new ChainWebSocketTransport({
    source: "l1",
    endpoint: "wss://example-l1.test",
    factory,
    baseBackoffMs: 1,
    maxBackoffMs: 4,
    staleTimeoutMs: 10_000,
    heartbeatIntervalMs: 5_000,
    onError: (e) => errors.push(e),
  });
  return { transport, sockets, errors, current: () => sockets[sockets.length - 1] };
}

describe("ChainWebSocketTransport", () => {
  it("connects and resolves once the socket opens", async () => {
    const { transport, current } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    expect(transport.isConnected).toBe(true);
  });

  it("subscribes to logs and delivers a notification tagged with source metadata", async () => {
    const { transport, current } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    const events: ChainNotification[] = [];
    const subscribePromise = transport.subscribeLogs("all", "confirmed", (n) => events.push(n));
    current().respondToLast(77);
    const id = await subscribePromise;
    expect(id).toBe(77);
    current().notify("logsNotification", 77, { context: { slot: 500 }, value: { signature: "sig1", err: null, logs: ["Program log: hi"] } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "l1", endpoint: "wss://example-l1.test", slot: 500, kind: "logs", signature: "sig1" });
  });

  it("distinguishes L1 from ER by source and endpoint, never conflating the two", async () => {
    const l1 = harness();
    const erSockets: FakeSocket[] = [];
    const er = new ChainWebSocketTransport({ source: "er", endpoint: "wss://example-er.test", factory: () => { const s = new FakeSocket(); erSockets.push(s); return s; }, baseBackoffMs: 1, maxBackoffMs: 4 });
    const l1Connecting = l1.transport.connect(); l1.current().open(); await l1Connecting;
    const erConnecting = er.connect(); erSockets[0].open(); await erConnecting;
    const l1Events: ChainNotification[] = []; const erEvents: ChainNotification[] = [];
    const l1Sub = l1.transport.subscribeLogs("all", "finalized", (n) => l1Events.push(n));
    l1.current().respondToLast(1); await l1Sub;
    const erSub = er.subscribeLogs("all", "confirmed", (n) => erEvents.push(n));
    erSockets[0].respondToLast(1); await erSub;
    l1.current().notify("logsNotification", 1, { context: {}, value: { err: null, logs: [] } });
    erSockets[0].notify("logsNotification", 1, { context: {}, value: { err: null, logs: [] } });
    expect(l1Events[0].source).toBe("l1");
    expect(erEvents[0].source).toBe("er");
    expect(l1Events[0].endpoint).not.toBe(erEvents[0].endpoint);
  });

  it("ignores a malformed (non-JSON) message without throwing or crashing the connection", async () => {
    const { transport, current, errors } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    expect(() => current().raw("not json{{{")).not.toThrow();
    expect(errors.some((e) => e.message.includes("malformed"))).toBe(true);
    expect(transport.isConnected).toBe(true);
  });

  it("rejects the pending subscribe call on an RPC error response", async () => {
    const { transport, current } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    const subscribePromise = transport.subscribeLogs("all", "confirmed", () => {});
    current().errorToLast("blocked");
    await expect(subscribePromise).rejects.toThrow("blocked");
  });

  it("reconnects with bounded exponential backoff after an unexpected disconnect", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets, current } = harness();
      const connecting = transport.connect();
      current().open();
      await connecting;
      current().serverClose();
      expect(transport.isConnected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      await Promise.resolve();
      expect(transport.isConnected).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("restores every non-one-shot subscription after a reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets, current } = harness();
      const connecting = transport.connect();
      current().open();
      await connecting;
      const handler = vi.fn();
      const subscribePromise = transport.subscribeLogs("all", "confirmed", handler);
      current().respondToLast(9);
      await subscribePromise;
      current().serverClose();
      await vi.advanceTimersByTimeAsync(1);
      const newSocket = sockets[sockets.length - 1];
      newSocket.open();
      await Promise.resolve();
      // The transport must have re-issued the exact same logsSubscribe.
      const resent = newSocket.lastRequest();
      expect(resent.method).toBe("logsSubscribe");
      newSocket.respondToLast(41);
      await Promise.resolve();
      newSocket.notify("logsNotification", 41, { context: {}, value: { err: null, logs: ["restored"] } });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ logs: ["restored"] }));
    } finally { vi.useRealTimers(); }
  });

  it("does not restore a one-shot signature subscription after it has already fired", async () => {
    const { transport, current } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    const handler = vi.fn();
    const subscribePromise = transport.subscribeSignature("sig-once", "confirmed", handler);
    current().respondToLast(5);
    await subscribePromise;
    current().notify("signatureNotification", 5, { context: {}, value: { err: null } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("delivers a duplicate notification for the same subscription as two separate calls (dedup is the indexer's job, not the transport's)", async () => {
    const { transport, current } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    const events: ChainNotification[] = [];
    const subscribePromise = transport.subscribeLogs("all", "confirmed", (n) => events.push(n));
    current().respondToLast(3);
    await subscribePromise;
    const payload = { context: { slot: 1 }, value: { signature: "dup", err: null, logs: [] } };
    current().notify("logsNotification", 3, payload);
    current().notify("logsNotification", 3, payload);
    expect(events).toHaveLength(2);
    expect(events[0].signature).toBe(events[1].signature);
  });

  it("delivers notifications out of slot order exactly as received (ordering is the indexer's job, not the transport's)", async () => {
    const { transport, current } = harness();
    const connecting = transport.connect();
    current().open();
    await connecting;
    const slots: (number | undefined)[] = [];
    const subscribePromise = transport.subscribeLogs("all", "confirmed", (n) => slots.push(n.slot));
    current().respondToLast(6);
    await subscribePromise;
    current().notify("logsNotification", 6, { context: { slot: 10 }, value: { err: null, logs: [] } });
    current().notify("logsNotification", 6, { context: { slot: 5 }, value: { err: null, logs: [] } });
    expect(slots).toEqual([10, 5]);
  });

  it("shuts down gracefully: unsubscribes, closes the socket, and never reconnects afterward", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets, current } = harness();
      const connecting = transport.connect();
      current().open();
      await connecting;
      const subscribePromise = transport.subscribeLogs("all", "confirmed", () => {});
      current().respondToLast(2);
      await subscribePromise;
      const shutdownPromise = transport.shutdown();
      current().respondToLast(true); // logsUnsubscribe response
      await shutdownPromise;
      expect(current().readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets).toHaveLength(1); // no reconnect attempted post-shutdown
    } finally { vi.useRealTimers(); }
  });

  it("force-closes and reconnects a stale connection that has stopped delivering any messages", async () => {
    vi.useFakeTimers();
    try {
      const now = { value: 0 };
      const sockets: FakeSocket[] = [];
      const transport = new ChainWebSocketTransport({
        source: "l1", endpoint: "wss://stale.test",
        factory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
        now: () => now.value, baseBackoffMs: 1, maxBackoffMs: 4, staleTimeoutMs: 1_000, heartbeatIntervalMs: 500,
      });
      const connecting = transport.connect();
      sockets[0].open();
      await connecting;
      now.value = 2_000;
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets[0].readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
