import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { runIngestionTick } from './index';
import { eventLogLine } from './test-event-fixtures';

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

const token = 'test-only-ingestion';
function request(path: string, body: unknown): Request {
  return new Request(`https://stockstream.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('routes a registered sequenced event through D1 indexing and rejects a sequence gap', async () => {
  const market = {
    symbol: 'TEST-PERP', instrumentId: 'instrument-test', marketIndex: 500,
    marketPda: 'market-test', vaultPda: 'vault-test', status: 'active',
    oracleFeedId: 'unverified-fixture', sessionPolicy: 'regular',
  };
  expect((await SELF.fetch(request('/v1/ingest/market', market))).status).toBe(202);
  const event = { id: 'event-test-1', symbol: market.symbol, kind: 'fill', payload: { quantity: '1' }, sequence: 1, domain: 'er', slot: 4, observedAt: 100 };
  expect((await SELF.fetch(request('/v1/ingest/market-event', event))).status).toBe(202);
  const gap = await SELF.fetch(request('/v1/ingest/market-event', { ...event, id: 'event-test-3', sequence: 3 }));
  expect(gap.status).toBe(409);
  expect(await gap.json()).toEqual({ error: 'sequence_gap', expected: 2 });
  const cursor = await bindings.DB!.prepare('SELECT sequence FROM indexer_cursors WHERE market_pda=? AND domain=?').bind('market-test', 'er').first<{ sequence: number }>();
  expect(cursor?.sequence).toBe(1);
});

it('runIngestionTick polls a registered market, decodes a real custody log, and ingests it through the durable pipeline', async () => {
  const market = {
    symbol: 'TICK-PERP', instrumentId: 'instrument-tick', marketIndex: 501,
    marketPda: 'tick-market', vaultPda: 'tick-vault', status: 'active',
    oracleFeedId: 'unverified-fixture', sessionPolicy: 'regular',
  };
  expect((await SELF.fetch(request('/v1/ingest/market', market))).status).toBe(202);

  const marketHex = 'ee'.repeat(32);
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { method: string; id: number; params: unknown[] };
    if (body.method === 'getSignaturesForAddress') {
      const address = body.params[0];
      const result = address === market.marketPda ? [{ signature: 'tick-sig-1', slot: 10, err: null }] : [];
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    if (body.method === 'getTransaction') {
      return Response.json({
        jsonrpc: '2.0', id: body.id,
        result: {
          slot: 10,
          transaction: { signatures: ['tick-sig-1'] },
          meta: { err: null, logMessages: [eventLogLine(400, 1, marketHex)] },
        },
      });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as unknown as typeof fetch;

  const result = await runIngestionTick(
    { ...bindings, SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env,
    fetcher,
  );
  // marketsPolled reflects every registered market (this D1 database is
  // shared with other tests in this file), but only this one has any new
  // signature in the fixture fetcher above.
  expect(result.marketsPolled).toBeGreaterThanOrEqual(1);
  expect(result.eventsIngested).toBe(1);
  const cursor = await bindings.DB!.prepare('SELECT sequence FROM indexer_cursors WHERE market_pda=? AND domain=?').bind('tick-market', 'l1').first<{ sequence: number }>();
  expect(cursor?.sequence).toBe(1);

  // A second tick with the same (already-processed) signature must not
  // re-ingest it.
  const again = await runIngestionTick({ ...bindings, SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env, fetcher);
  expect(again.eventsIngested).toBe(0);
});

it('runIngestionTick is a no-op when no RPC endpoint is configured, rather than throwing', async () => {
  const result = await runIngestionTick({ ...bindings, SOLANA_RPC_URL: undefined } as unknown as Env);
  expect(result).toEqual({ marketsPolled: 0, eventsIngested: 0 });
});

it('reports keeper health (leases and due dead letters), and requires authorization', async () => {
  const unauthorized = await SELF.fetch(new Request('https://stockstream.test/v1/health/keepers'));
  expect(unauthorized.status).toBe(401);
  const response = await SELF.fetch(new Request('https://stockstream.test/v1/health/keepers', { headers: { Authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(200);
  const body = await response.json<{ deadLetters: { due: number }; leases: unknown[] }>();
  expect(typeof body.deadLetters.due).toBe('number');
  expect(Array.isArray(body.leases)).toBe(true);
});
