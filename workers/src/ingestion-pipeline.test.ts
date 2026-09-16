import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { MagicBlockErTransport, SolanaL1Transport } from "./chain-transports";
import { AccountSnapshotFetcher, ingestLogsNotification } from "./ingestion-pipeline";
import { IndexerRepository } from "./repositories";
import { MarketIndexer } from "./indexer-service";
import type { LogsNotification } from "./ws-transport";
import type { MarketDefinition, MarketEvent } from "./types";

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

const market = "cc".repeat(32);
const mint = "dd".repeat(32);

function notification(logs: string[], overrides: Partial<LogsNotification> = {}): LogsNotification {
  return { kind: "logs", source: "l1", endpoint: "wss://l1.test", commitment: "confirmed", receivedAt: 1, signature: "sig-a", slot: 100, err: null, logs, ...overrides };
}

function accountInfoResponse(bytes: Uint8Array, slot: number) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value: { data: [btoa(binary), "base64"], owner: "prog", lamports: 1 } } }), { headers: { "content-type": "application/json" } });
}

function marketAccountBytes(mode: number, globalEventSequence: bigint): Uint8Array {
  const bytes = new Uint8Array(270);
  bytes[11] = mode;
  new DataView(bytes.buffer).setBigUint64(262, globalEventSequence, true);
  return bytes;
}

it("ingestLogsNotification decodes a live logs notification straight into MarketIndexer.ingest", async () => {
  const indexer = new MarketIndexer(
    new IndexerRepository(bindings.DB!),
    { snapshot: async () => { throw new Error("no gap expected"); } },
    () => ({ publish: async () => "applied", replaceSnapshot: async () => ({ accepted: true }) }),
  );
  const results = await ingestLogsNotification(indexer, "pipeline-market-1", notification([
    `Program log: SS:CollateralDeposited market=${market} seat=1 amount=100 seq=1 balance=100 mint=${mint}`,
  ]));
  expect(results).toEqual(["applied"]);
  expect((await new IndexerRepository(bindings.DB!).cursor("pipeline-market-1", "l1"))?.sequence).toBe(1);
});

it("ingestLogsNotification skips a failed transaction's logs entirely", async () => {
  const indexer = new MarketIndexer(
    new IndexerRepository(bindings.DB!),
    { snapshot: async () => { throw new Error("no gap expected"); } },
    () => ({ publish: async () => "applied", replaceSnapshot: async () => ({ accepted: true }) }),
  );
  const results = await ingestLogsNotification(indexer, "pipeline-market-failed", notification(
    [`Program log: SS:CollateralDeposited market=${market} amount=1 seq=1 balance=1 mint=${mint}`],
    { err: { InstructionError: [0, "Custom"] } },
  ));
  expect(results).toEqual([]);
});

it("ingestLogsNotification ignores logs with no recognizable custody events", async () => {
  const indexer = new MarketIndexer(
    new IndexerRepository(bindings.DB!),
    { snapshot: async () => { throw new Error("no gap expected"); } },
    () => ({ publish: async () => "applied", replaceSnapshot: async () => ({ accepted: true }) }),
  );
  expect(await ingestLogsNotification(indexer, "pipeline-market-noop", notification(["Program log: unrelated"]))).toEqual([]);
});

it("AccountSnapshotFetcher decodes the real market header's mode and global_event_sequence", async () => {
  const bytes = marketAccountBytes(3, 42n); // 3 = Emergency -> "restricted"
  const fetcher: typeof fetch = vi.fn(async () => accountInfoResponse(bytes, 555));
  const l1 = new SolanaL1Transport("https://l1.test", fetcher);
  const er = new MagicBlockErTransport("https://er.test", fetcher);
  const definition: MarketDefinition = { symbol: "AAPL-PERP", instrumentId: "instr", marketIndex: 0, marketPda: "market-x", vaultPda: "vault-x", status: "active", oracleFeedId: "feed", sessionPolicy: "regular" };
  const snapshotFetcher = new AccountSnapshotFetcher(l1, er, () => definition, () => 999);
  const result = await snapshotFetcher.snapshot("market-x", "l1");
  expect(result.sequence).toBe(42);
  expect(result.slot).toBe(555);
  expect(result.snapshot.market.status).toBe("restricted");
  expect(result.snapshot.market.symbol).toBe("AAPL-PERP");
  expect(result.snapshot.events).toEqual([]);
});

it("AccountSnapshotFetcher rejects a missing account rather than fabricating an empty snapshot", async () => {
  const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } }), { headers: { "content-type": "application/json" } }));
  const l1 = new SolanaL1Transport("https://l1.test", fetcher);
  const er = new MagicBlockErTransport("https://er.test", fetcher);
  const snapshotFetcher = new AccountSnapshotFetcher(l1, er, () => { throw new Error("should not be called"); });
  await expect(snapshotFetcher.snapshot("missing", "l1")).rejects.toThrow("market account not found");
});

it("end to end: a live gap on a real logsNotification triggers a real resnapshot via the account fetcher, applied to durable D1 and the MarketStream Durable Object", async () => {
  const bytes = marketAccountBytes(1, 5n); // Open, sequence already at 5
  const fetcher: typeof fetch = vi.fn(async () => accountInfoResponse(bytes, 777));
  const l1 = new SolanaL1Transport("https://l1.test", fetcher);
  const er = new MagicBlockErTransport("https://er.test", fetcher);
  const definition: MarketDefinition = { symbol: "AAPL-PERP", instrumentId: "instr", marketIndex: 0, marketPda: "e2e-market", vaultPda: "vault", status: "active", oracleFeedId: "feed", sessionPolicy: "regular" };
  const snapshotFetcher = new AccountSnapshotFetcher(l1, er, () => definition);
  const stream = env.MARKET_STREAM!.getByName("e2e-pipeline");
  const indexer = new MarketIndexer(new IndexerRepository(bindings.DB!), snapshotFetcher, () => stream);

  // First event arrives at sequence 1 as expected.
  await ingestLogsNotification(indexer, "e2e-market", notification(
    [`Program log: SS:CollateralDeposited market=${market} amount=1 seq=1 balance=1 mint=${mint}`],
    { signature: "sig-1" },
  ));
  // A gap: the next observed sequence jumps straight to 6 (matching the
  // fetcher's fixture sequence of 5, so the resnapshot lands exactly where
  // the "authoritative" account said it should).
  const results = await ingestLogsNotification(indexer, "e2e-market", notification(
    [`Program log: SS:CollateralDeposited market=${market} amount=1 seq=6 balance=2 mint=${mint}`],
    { signature: "sig-6" },
  ));
  expect(results).toEqual(["resnapshotted"]);
  expect((await new IndexerRepository(bindings.DB!).cursor("e2e-market", "l1"))?.sequence).toBe(5);
  const snapshotResponse = await stream.fetch(new Request("https://test/snapshot"));
  const snapshotBody = await snapshotResponse.json<{ domains: { domain: string; sequence: number }[] }>();
  const l1Domain = snapshotBody.domains.find((d) => d.domain === "l1");
  expect(l1Domain?.sequence).toBe(5);
});
