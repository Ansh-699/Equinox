import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { CommitRecordRepository, IndexerRepository, KeeperCursorRepository, OracleUpdateRepository, ProtocolRepository, TxAttemptRepository } from './repositories';
import { runDurableKeeper } from './keepers';

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.DB!;
beforeAll(async () => { await applyD1Migrations(db, bindings.TEST_MIGRATIONS); });

it('migrates D1 and fences expired lease takeover across instances', async () => {
  const a = new ProtocolRepository(db), b = new ProtocolRepository(db);
  const first = await a.acquire('lease', 'a', 100, 1000);
  expect(first?.fence).toBe(1);
  expect(await b.acquire('lease', 'b', 100, 1099)).toBeNull();
  const second = await b.acquire('lease', 'b', 100, 1100);
  expect(second?.fence).toBe(2);
  expect(await a.renew(first!, 100, 1101)).toBeNull();
  expect(await a.release(first!)).toBe(false);
  expect(await b.release(second!)).toBe(true);
  expect((await a.acquire('lease', 'a', 100, 1102))?.fence).toBe(3);
});

it('atomically reserves idempotency and rejects stale keeper completion', async () => {
  const repo = new ProtocolRepository(db);
  const lease = (await repo.acquire('op-lease', 'a', 100, 1000))!;
  expect(await repo.reserve('operation', 'a', 'hash', 100, 1000)).toBe(true);
  expect(await repo.reserve('operation', 'b', 'hash', 100, 1000)).toBe(false);
  await expect(repo.finish('operation', 'b', 'succeeded', {}, lease, 1001)).rejects.toThrow();
  await repo.finish('operation', 'a', 'succeeded', { signature: 'fixture' }, lease, 1001);
  expect((await new ProtocolRepository(db).operation('operation'))?.status).toBe('succeeded');
  await expect(repo.finish('operation', 'a', 'succeeded', {}, lease, 1002)).rejects.toThrow();
});

it('enforces rate limits across service instances and resets after expiration', async () => {
  const a = new ProtocolRepository(db), b = new ProtocolRepository(db);
  expect(await a.allow('rate', 2, 100, 1000)).toBe(true);
  expect(await b.allow('rate', 2, 100, 1001)).toBe(true);
  expect(await a.allow('rate', 2, 100, 1002)).toBe(false);
  expect(await b.allow('rate', 2, 100, 1100)).toBe(true);
});

it('cleanup retains ambiguous pending submissions and fencing history', async () => {
  const repo = new ProtocolRepository(db);
  await repo.reserve('pending', 'a', 'hash', 1, 1);
  await repo.allow('expired-rate', 1, 1, 1);
  await repo.acquire('retained-fence', 'a', 1, 1);
  await repo.cleanup(10_000);
  expect((await repo.operation('pending'))?.status).toBe('pending');
  expect(await db.prepare("SELECT * FROM rate_limits WHERE key='expired-rate'").first()).toBeNull();
  expect((await repo.acquire('retained-fence', 'b', 1, 10_001))?.fence).toBe(2);
});

it('persists ordered indexer cursors, suppresses duplicates, and replaces a projection after a gap', async () => {
  const indexer = new IndexerRepository(db);
  expect(await indexer.append('market-a', 'er', 1, 10, 'event-1', { type: 'fill' }, 1)).toEqual({ kind: 'applied' });
  expect(await indexer.append('market-a', 'er', 1, 10, 'event-1', { type: 'fill' }, 2)).toEqual({ kind: 'duplicate' });
  expect(await indexer.append('market-a', 'er', 3, 12, 'event-3', { type: 'fill' }, 3)).toEqual({ kind: 'gap', expected: 2 });
  expect((await indexer.cursor('market-a', 'er'))?.sequence).toBe(1);
  await indexer.replaceSnapshot('market-a', 'er', 3, 12, { bids: [] }, 4);
  expect(await indexer.snapshot('market-a', 'er')).toEqual({ sequence: 3, snapshot: { bids: [] } });
  expect(await indexer.append('market-a', 'er', 4, 13, 'event-4', { type: 'fill' }, 5)).toEqual({ kind: 'applied' });
});

it('records and resolves a keeper transaction attempt, and lists recent attempts for a market', async () => {
  const repo = new TxAttemptRepository(db);
  await repo.submitted('attempt-1', 'pyth', 'market-tx', 'l1', 'sig-1', 1000);
  await repo.resolved('attempt-1', 'confirmed', null, 1005);
  const recent = await repo.recentForMarket('market-tx', 'pyth');
  expect(recent).toHaveLength(1);
  expect(recent[0]).toMatchObject({ id: 'attempt-1', signature: 'sig-1', status: 'confirmed', resolvedAt: 1005 });
});

it('dedupes an oracle update by exact timestamp+hash and treats a different hash at the same timestamp as new', async () => {
  const repo = new OracleUpdateRepository(db);
  expect(await repo.alreadyApplied('market-oracle', 100, 'hash-a')).toBe(false);
  await repo.record('market-oracle', 'feed-1', 100, 'hash-a', 'confirmed', 1000);
  expect(await repo.alreadyApplied('market-oracle', 100, 'hash-a')).toBe(true);
  expect(await repo.alreadyApplied('market-oracle', 100, 'hash-b')).toBe(false);
});

it('tracks the last requested commit sequence per market independent of confirmation status', async () => {
  const repo = new CommitRecordRepository(db);
  expect(await repo.lastRequestedSequence('market-commit')).toBe(0);
  await repo.record('market-commit', 1, 'er', 'requested', 'sig-1', 1000);
  await repo.record('market-commit', 2, 'er', 'requested', 'sig-2', 1001);
  expect(await repo.lastRequestedSequence('market-commit')).toBe(2);
  await repo.record('market-commit', 2, 'l1', 'confirmed', 'sig-2', 1002);
  expect(await repo.lastRequestedSequence('market-commit')).toBe(2);
});

it('persists a keeper continuation cursor across a simulated restart', async () => {
  const repo = new KeeperCursorRepository(db);
  expect(await repo.get('cleanup', 'market-cursor')).toBeNull();
  await repo.set('cleanup', 'market-cursor', { seatIndex: 12 }, 1000);
  expect(await new KeeperCursorRepository(db).get('cleanup', 'market-cursor')).toEqual({ seatIndex: 12 });
  await repo.set('cleanup', 'market-cursor', { seatIndex: 40 }, 1001);
  expect(await repo.get('cleanup', 'market-cursor')).toEqual({ seatIndex: 40 });
});

it('runs a durable keeper once and returns its persisted result on a duplicate schedule', async () => {
  const repository = new ProtocolRepository(db);
  const request = {
    leaseKey: 'keeper:test', holder: 'worker-a', idempotencyKey: 'keeper-op', requestHash: 'input-v1',
    now: 50_000, leaseTtlMs: 100, idempotencyTtlMs: 1_000,
  };
  expect(await runDurableKeeper(repository, { ...request, work: async () => ({ committed: 1 }) })).toEqual({ committed: 1 });
  expect(await runDurableKeeper(repository, { ...request, holder: 'worker-b', work: async () => ({ committed: 2 }) })).toEqual({ committed: 1 });
});
