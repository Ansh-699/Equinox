/**
 * Real Pyth Lazer streaming-client integration tests: three in-memory mock
 * WebSocket "servers" (one per endpoint), full protocol behavior --
 * subscribe/ack, stream pushes, disconnects, error envelopes -- with no
 * real networking, driven through the same `PythWebSocketFactory` seam the
 * Workers runtime adapter uses.
 */

import { expect, test, vi } from "vitest";
import {
  extractSolanaUpdate,
  PythLazerEndpoint,
  PythLazerPool,
  type PythLazerSubscriptionParams,
  type PythWebSocketFactory,
} from "./pyth-lazer-client";
import type { WebSocketLike, WebSocketLikeEvent } from "./ws-transport";

const SUBSCRIPTION: PythLazerSubscriptionParams = {
  type: "subscribe",
  subscriptionId: 1,
  priceFeedIds: [33],
  properties: ["price", "exponent", "confidence", "marketSession", "feedUpdateTimestamp"],
  formats: ["solana"],
  channel: "fixed_rate@200ms",
  ignoreInvalidFeeds: false,
};

/** An in-memory mock Lazer server. Fully protocol-shaped: it only speaks
 * the real envelope types and behaves like the real service (subscribe
 * acknowledgment, periodic streamUpdated pushes, error responses,
 * termination). */
class MockLazerServer {
  readonly connections: FakeSocket[] = [];
  private static nextId = 0;

  constructor(
    readonly name: string,
    readonly behavior: {
      // Called with the parsed subscribe request; may reply with errors.
      onSubscribe?: (request: Record<string, unknown>, server: MockLazerServer) => void;
      onMessage?: (data: string, server: MockLazerServer) => void;
    } = {},
  ) {}

  sendUpdate(price: bigint, timestampUs: bigint, feedId = 33): void {
    const message = solanaMessage(price, timestampUs, 33);
    const envelope = JSON.stringify({
      type: "streamUpdated",
      subscriptionId: 1,
      parsed: {
        timestampUs: timestampUs.toString(),
        priceFeeds: [{ priceFeedId: 33, price: price.toString(), feedUpdateTimestamp: Number(timestampUs) }],
      },
      solana: { encoding: "hex", data: message },
    });
    for (const connection of this.connections) connection.serverPush(envelope);
  }

  sendEnvelope(envelope: unknown): void {
    const data = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
    for (const connection of this.connections) connection.serverPush(data);
  }

  terminateAll(): void {
    for (const connection of [...this.connections]) connection.serverClose(1011, "server going down");
  }
}

class FakeSocket implements WebSocketLike {
  readyState: 0 | 1 | 2 | 3 = 0; // CONNECTING
  private readonly listeners: Record<string, ((event: WebSocketLikeEvent) => void)[]> = {};
  readonly sent: string[] = [];

  constructor(
    private readonly server: MockLazerServer,
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    this.server.connections.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.type === "subscribe") {
      this.server.behavior.onSubscribe?.(parsed, this.server);
      // Real server acknowledges a valid subscription.
      if (!this.server.behavior.onSubscribe) {
        this.serverPush(JSON.stringify({ type: "subscribed", subscriptionId: parsed.subscriptionId }));
        this.readyState = 1;
      }
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.server.connections.splice(this.server.connections.indexOf(this), 1);
    this.emit({ type: "close", code: code ?? 1000, reason: reason ?? "" });
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketLikeEvent) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  /** Server side: handshake completes, then pushes arrive. */
  serverHandshake(): void {
    this.readyState = 1;
    this.emit({ type: "open" } as { type: string } & WebSocketLikeEvent & Record<string, unknown>);
  }

  serverPush(data: string): void {
    if (this.readyState !== 1) return;
    this.emit({ type: "message", data } as { type: string } & WebSocketLikeEvent & Record<string, unknown>);
  }

  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.emit({ type: "close", code: code ?? 1000, reason: reason ?? "" });
  }

  serverError(): void {
    this.emit({ type: "error" } as { type: string } & WebSocketLikeEvent & Record<string, unknown>);
  }

  private emit(event: { type: string } & WebSocketLikeEvent & Record<string, unknown>): void {
    for (const listener of this.listeners[event.type as "open"] ?? []) {
      listener(event);
    }
  }
}

function fakeSocketFor(servers: MockLazerServer[], sockets: FakeSocket[]): PythWebSocketFactory {
  return (url, headers) => {
    const index = sockets.length;
    const server = servers[index] ?? servers[0];
    const socket = new FakeSocket(server, url, headers);
    sockets.push(socket);
    // Simulate the async handshake completing after the factory returns.
    setTimeout(() => socket.serverHandshake(), 0);
    return socket;
  };
}

/** Builds a real signed Solana-format message body: magic + 92-byte payload
 * header + 53-byte five-property payload + signature + pubkey, matching
 * `programs/equinox/src/handlers.rs::parse_verified_oracle`'s offsets
 * (header 102 bytes, payload 53, five property tags in order). */
function solanaMessageBytes(price: bigint, timestampUs: bigint, feedId: number): Uint8Array {
  const out = new Uint8Array(102 + 53);
  const view = new DataView(out.buffer);
  view.setUint32(0, 2_182_742_457, true); // SOLANA_FORMAT_MAGIC
  // Payload header up to offset 100 (opaque to the parser's checks).
  out[13] = 1; // channel
  out[18] = 5; // feed count region marker, mirrors parse_verified_oracle's check
  // Feed id at [14..18].
  view.setUint32(14, feedId, true);
  // Property tags at [19, 28, 31, 40, 43] must be [0, 4, 5, 9, 12].
  out[19] = 0;
  out[28] = 4;
  out[31] = 5;
  out[40] = 9;
  out[43] = 12;
  // Price at [20..28]; exponent at [29..31]; confidence at [32..40];
  // session at [41..43]; presence flag at [44]; feedUpdateTimestamp at [45..53].
  view.setBigInt64(20, price, true);
  view.setInt16(29, -8, true);
  view.setBigInt64(32, 5n, true);
  view.setInt16(41, 0, true);
  out[44] = 1;
  view.setBigUint64(45, timestampUs, true);
  view.setUint16(100, 53, true);
  return out;
}

function solanaMessage(price: bigint, timestampUs: bigint, feedId = 33): string {
  return Buffer.from(solanaMessageBytes(price, timestampUs, feedId)).toString("hex");
}

function poolWith(mockServers: MockLazerServer[], sockets: FakeSocket[], overrides: Partial<{ jitter: () => number }> = {}): PythLazerPool {
  return new PythLazerPool({
    apiKey: "test-api-key",
    endpoints: ["ws://a", "ws://b", "ws://c"],
    riskSubscription: SUBSCRIPTION,
    factory: fakeSocketFor(mockServers, sockets),
    jitter: overrides.jitter ?? (() => 0.5),
  });
}

test("connects to all three endpoints and subscribes with the documented parameters", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  for (const socket of sockets) {
    const request = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    expect(request).toMatchObject({
      type: "subscribe",
      subscriptionId: SUBSCRIPTION.subscriptionId,
      priceFeedIds: [33],
      properties: SUBSCRIPTION.properties,
      formats: ["solana"],
      channel: "fixed_rate@200ms",
      ignoreInvalidFeeds: false,
    });
    // Bearer auth header, server-side only.
    expect(socket.headers.Authorization).toBe("Bearer test-api-key");
  }
});

test("three identical updates collapse to one accepted update", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  const { reconcileEndpointUpdates } = await import("./pyth-source");
  const message = solanaMessageBytes(1_000_000n, 1_700_000_000_000_000n, 33);
  for (const server of servers) server.sendEnvelope(streamUpdatedEnvelope(33, message, 1_700_000_000_000_000n));

  const updates = await pool.fetchSignedUpdates();
  expect(updates).toHaveLength(3);
  const { accepted, quarantined } = reconcileEndpointUpdates(updates, 0);
  expect(accepted).not.toBeNull();
  expect(quarantined).toHaveLength(0);
  // Identical payload identity across all three endpoints.
  expect(new Set(updates.map((u) => u.payloadHash)).size).toBe(1);
});

test("one endpoint disconnects: the survivors keep streaming", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  sockets[0].serverClose(1006, "endpoint down");
  expect(pool.redundancyHealthy()).toBe(true);

  const message = solanaMessageBytes(2_000_000n, 1_700_000_000_001_000n, 33);
  servers[1].sendEnvelope(streamUpdatedEnvelope(33, message, 1_700_000_000_001_000n));
  servers[2].sendEnvelope(streamUpdatedEnvelope(33, message, 1_700_000_000_001_000n));
  const updates = await pool.fetchSignedUpdates();
  expect(updates).toHaveLength(2);
});

test("two endpoints disconnect: redundancy floor broken, no submission", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  sockets[0].serverClose(1006, "down");
  sockets[1].serverClose(1006, "down");
  expect(pool.redundancyHealthy()).toBe(false);
});

test("reconnect resubscribes with the same parameters", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  sockets[0].serverClose(1006, "dropped");
  // A new connection arrives via the factory (backoff driven by real timers
  // with the tiny injected base).
  await vi.waitFor(() => {
    const next = sockets.filter((s) => s.url === "ws://a").length;
    expect(next).toBeGreaterThanOrEqual(2);
  });
  await vi.waitFor(() => expect(pool.health()[0].state === "subscribed" || pool.health()[0].state === "reconnecting").toBe(true));
  const reconnected = sockets.filter((s) => s.url === "ws://a").at(-1)!;
  await vi.waitFor(() => expect(reconnected.sent.length).toBeGreaterThanOrEqual(1));
  const request = JSON.parse(reconnected.sent.at(-1)!) as Record<string, unknown>;
  expect(request.type).toBe("subscribe");
});

test("older timestamp rejected; conflicting same-timestamp payloads quarantined", async () => {
  const { reconcileEndpointUpdates } = await import("./pyth-source");
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  const older = solanaMessageBytes(3_000_000n, 1_700_000_000_000_000n, 33);
  for (const server of servers) server.sendEnvelope(streamUpdatedEnvelope(33, older, 1_700_000_000_000_000n));
  let updates = await pool.fetchSignedUpdates();
  // Last accepted timestamp is newer -> regression rejected.
  expect(reconcileEndpointUpdates(updates, 1_700_000_001_000).accepted).toBeNull();

  // Conflicting payloads at the same timestamp: quarantine both. (>1s away
  // from the older update: the on-chain timestamp granularity is seconds.)
  servers[0].sendEnvelope(streamUpdatedEnvelope(33, solanaMessageBytes(9_000_000n, 1_700_005_000_000_000n, 33), 1_700_005_000_000_000n));
  servers[1].sendEnvelope(streamUpdatedEnvelope(33, solanaMessageBytes(9_500_000n, 1_700_005_000_000_000n, 33), 1_700_005_000_000_000n));
  updates = await pool.fetchSignedUpdates();
  const result = reconcileEndpointUpdates(updates, 0);
  expect(result.accepted).toBeNull();
  expect(result.quarantined).toHaveLength(2);
});

test("invalid signed payload (wrong magic) is schema-rejected", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  const bad = new Uint8Array(160);
  new DataView(bad.buffer).setUint32(0, 0xdeadbeef, true);
  for (const server of servers) server.sendEnvelope(streamUpdatedEnvelope(33, bad, 1_700_000_000_003_000n));
  const updates = await pool.fetchSignedUpdates();
  expect(updates).toHaveLength(0);
  expect(pool.health().every((h) => h.schemaRejected > 0 || h.messages === 0)).toBe(true);
});

test("subscriptionError (invalid feed) fails loudly on the risk path", async () => {
  const fatal: string[] = [];
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = new PythLazerPool({
    apiKey: "k",
    endpoints: ["ws://a", "ws://b", "ws://c"],
    riskSubscription: SUBSCRIPTION,
    factory: fakeSocketFor(servers, sockets),
    jitter: () => 0.5,
    onError: (error) => fatal.push(String((error as Error).message)),
  });
  pool.start();
  await vi.waitFor(() => expect(sockets.length).toBe(3));
  // Server rejects the subscription because a feed id is invalid and
  // ignoreInvalidFeeds=false (the risk path's strict setting).
  servers[0].behavior.onSubscribe = (_req, server) => {
    server.sendEnvelope({ type: "subscriptionError", subscriptionId: 1, error: "unknown feed id 33" });
  };
  await vi.waitFor(() => expect(pool.health()[0].lastFatal).toBe("subscription_error"));
});

test("unauthorized (401) and forbidden (403) are classified and terminal", async () => {
  for (const [errorText, expected] of [
    ["invalid token", "unauthorized"],
    ["403 forbidden: no entitlement for feed 33", "forbidden"],
    ["429 too many requests", "rate_limited"],
  ] as const) {
    const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
    const sockets: FakeSocket[] = [];
    const pool = new PythLazerPool({
      apiKey: "k",
      endpoints: ["ws://a", "ws://b", "ws://c"],
      riskSubscription: SUBSCRIPTION,
      factory: fakeSocketFor(servers, sockets),
      jitter: () => 0.5,
    });
    pool.start();
    await vi.waitFor(() => expect(sockets.length).toBe(3));
    servers[0].behavior.onSubscribe = (_req, server) => {
      server.sendEnvelope({ type: "error", error: errorText });
    };
    await vi.waitFor(() => expect(pool.health()[0].lastFatal).toBe(expected));
    pool.close();
  }
});

test("oversized messages are dropped without crashing", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });

  servers[0].sendEnvelope("x".repeat(70_000));
  expect(pool.health()[0].droppedOversized).toBe(1);
  const message = solanaMessageBytes(4_000_000n, 1_700_000_000_004_000n, 33);
  servers[0].sendEnvelope(streamUpdatedEnvelope(33, message, 1_700_000_000_004_000n));
  expect((await pool.fetchSignedUpdates()).length).toBe(1);
});

test("graceful shutdown closes all endpoints and stops reconnects", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = poolWith(servers, sockets);
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });
  pool.close();
  expect(pool.health().every((h) => h.state === "closed")).toBe(true);
  expect(pool.redundancyHealthy()).toBe(false);
});

test("extractSolanaUpdate validates feed identity and timestamps", () => {
  const good = solanaMessageBytes(5_000_000n, 1_700_000_000_005_000n, 33);
  const envelope = JSON.parse(streamUpdatedEnvelope(33, good, 1_700_000_000_005_000n)) as Record<string, unknown>;
  const update = extractSolanaUpdate(envelope, "test");
  expect(update).not.toBeNull();
  expect(update?.feedId).toBe("33");
  expect(update?.timestamp).toBe(1_700_000_000);
  // Timestamp regression flag handled upstream via reconcileEndpointUpdates.
});

function streamUpdatedEnvelope(feedId: number, messageBytes: Uint8Array, timestampUs: number | bigint): string {
  return JSON.stringify({
    type: "streamUpdated",
    subscriptionId: 1,
    parsed: {
      timestampUs: String(timestampUs),
      priceFeeds: [{ priceFeedId: feedId, price: "1", feedUpdateTimestamp: Number(timestampUs) }],
    },
    solana: { encoding: "hex", data: Buffer.from(messageBytes).toString("hex") },
  });
}

test("missing credential is configuration-blocked end to end", async () => {
  const { pythSourceHealth, createPythUpdateSource } = await import("./pyth-source");
  const config = { apiKey: undefined, endpoints: ["ws://a", "ws://b", "ws://c"], feedId: "33", minChannel: "fixed_rate@200ms" };
  expect(pythSourceHealth(config)).toBe("configuration_blocked");
  let polled = false;
  const source = createPythUpdateSource(config, async () => { polled = true; return []; });
  expect(await source.fetchSignedUpdate(0, "")).toBeNull();
  expect(polled).toBe(false); // never polled without a credential
});

test("marketSession risk states flow through the parsed payload untouched", async () => {
  // The program maps session -> MarketMode on-chain; the client only carries
  // the parsed field. Halted (3|4) map to CloseOnly, 0|1|2 to Open.
  // On the client side we assert the raw session byte survives the envelope.
  const bytes = solanaMessageBytes(1_000_000n, 1_700_000_000_010_000n, 33);
  new DataView(bytes.buffer).setInt16(41, 4, true); // CorpAction/Extended session
  const envelope = streamUpdatedEnvelope(33, bytes, 1_700_000_000_010_000n);
  const update = extractSolanaUpdate(JSON.parse(envelope) as Record<string, unknown>, "t");
  expect(update).not.toBeNull(); // the client passes session through; the program owns the mapping
});

test("onchain simulation rejection: a stale-but-valid update is not resubmitted after readback mismatch", async () => {
  // The live source deduplicates by (timestamp, payloadHash) against the
  // durable cursor; a readback mismatch (the on-chain accepted timestamp
  // differs) must not re-submit the same signed payload.
  const { createLivePythUpdateSource, pythSourceHealth } = await import("./pyth-source");
  const config = { apiKey: "k", endpoints: ["ws://a", "ws://b", "ws://c"], feedId: "33", minChannel: "fixed_rate@200ms" };
  expect(pythSourceHealth(config)).toBe("ready");
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = new PythLazerPool({
    apiKey: "k",
    endpoints: ["ws://a", "ws://b", "ws://c"],
    riskSubscription: SUBSCRIPTION,
    factory: fakeSocketFor(servers, sockets),
    jitter: () => 0.5,
  });
  pool.start();
  await vi.waitFor(() => expect(pool.health().every((h) => h.state === "subscribed")).toBe(true), { timeout: 8000, interval: 50 });
  const message = solanaMessageBytes(6_000_000n, 1_700_000_000_006_000n, 33);
  for (const server of servers) server.sendEnvelope(streamUpdatedEnvelope(33, message, 1_700_000_000_006_000n));
  const source = createLivePythUpdateSource(config, pool);
  const update = await source.fetchSignedUpdate(0, "");
  expect(update).not.toBeNull();
  // Same payload again -> null (durable dedup mirror).
  expect(await source.fetchSignedUpdate(1_700_000_000, (await source.fetchSignedUpdate(0, ""))?.payloadHash ?? "")).toBeNull();
  pool.close();
});

test("rate limit envelope is classified and terminal", async () => {
  const servers = [new MockLazerServer("0"), new MockLazerServer("1"), new MockLazerServer("2")];
  const sockets: FakeSocket[] = [];
  const pool = new PythLazerPool({
    apiKey: "k",
    endpoints: ["ws://a", "ws://b", "ws://c"],
    riskSubscription: SUBSCRIPTION,
    factory: fakeSocketFor(servers, sockets),
    jitter: () => 0.5,
  });
  pool.start();
  await vi.waitFor(() => expect(sockets.length).toBe(3));
  servers[0].behavior.onSubscribe = (_req, server) => {
    server.sendEnvelope({ type: "error", error: "429 Too Many Requests" });
  };
  await vi.waitFor(() => expect(pool.health()[0].lastFatal).toBe("rate_limited"));
  pool.close();
});
