import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { IndexerRepository } from './repositories';
import { MarketIndexer } from './indexer-service';
import type { MarketEvent, MarketSnapshot } from './types';

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

function event(sequence: number): MarketEvent {
  return { id: `indexer-service-${sequence}`, symbol: 'AAPL-PERP', kind: 'fill', payload: { quantity: 1 }, observedAt: sequence, sequence, domain: 'er' };
}

it('repairs a durable sequence gap from an authoritative snapshot before later deltas resume', async () => {
  const publications: string[] = [];
  const snapshot: MarketSnapshot = {
    symbol: 'AAPL-PERP', sequence: 3, domain: 'er', capturedAt: 3,
    market: { symbol: 'AAPL-PERP', instrumentId: 'fixture', marketIndex: 0, marketPda: 'indexer-market', vaultPda: 'vault', status: 'active', oracleFeedId: 'feed', sessionPolicy: 'regular' }, events: [],
  };
  const indexer = new MarketIndexer(new IndexerRepository(bindings.DB!), {
    snapshot: async () => ({ sequence: 3, slot: 30, snapshot }),
  }, () => ({
    publish: async item => { publications.push(`delta:${item.sequence}`); return 'applied'; },
    replaceSnapshot: async item => { publications.push(`snapshot:${item.sequence}`); return { accepted: true }; },
  }));
  expect(await indexer.ingest('indexer-market', event(1))).toBe('applied');
  expect(await indexer.ingest('indexer-market', event(3))).toBe('resnapshotted');
  expect((await new IndexerRepository(bindings.DB!).cursor('indexer-market', 'er'))?.sequence).toBe(3);
  expect(await indexer.ingest('indexer-market', event(4))).toBe('applied');
  expect(publications).toEqual(['delta:1', 'snapshot:3', 'delta:4']);
});
