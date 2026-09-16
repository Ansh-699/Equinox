import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';

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
