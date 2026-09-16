import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { ProtocolRepository } from './repositories';

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
