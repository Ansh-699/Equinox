export interface LeaseStore {
  acquire(key: string, holder: string, ttlMs: number, now: number): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
}

export interface IdempotencyStore {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown): Promise<void>;
}

export interface KeeperResult<T> { value: T; retryAfterMs?: number; }

export async function withLease<T>(store: LeaseStore, key: string, holder: string, ttlMs: number, work: () => Promise<T>, now = Date.now): Promise<T> {
  if (!(await store.acquire(key, holder, ttlMs, now()))) throw new Error("keeper lease unavailable");
  try { return await work(); } finally { await store.release(key, holder); }
}

export async function idempotent<T>(store: IdempotencyStore, key: string, work: () => Promise<T>): Promise<T> {
  const existing = await store.get(key);
  if (existing !== null) return existing as T;
  const result = await work();
  await store.put(key, result);
  return result;
}

export function retryDelay(attempt: number, baseMs = 250, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export interface DurableKeeperRequest<T> {
  leaseKey: string;
  holder: string;
  idempotencyKey: string;
  requestHash: string;
  now: number;
  leaseTtlMs: number;
  idempotencyTtlMs: number;
  work: () => Promise<T>;
}

/** Executes a keeper action with D1 fencing and durable idempotency. A failed
 * worker cannot complete an operation after its lease has been taken over. */
export async function runDurableKeeper<T>(repository: ProtocolRepository, request: DurableKeeperRequest<T>): Promise<T> {
  const lease = await repository.acquire(request.leaseKey, request.holder, request.leaseTtlMs, request.now);
  if (!lease) throw new Error('keeper lease unavailable');
  try {
    const reserved = await repository.reserve(request.idempotencyKey, request.holder, request.requestHash, request.idempotencyTtlMs, request.now);
    if (!reserved) {
      const existing = await repository.operation(request.idempotencyKey);
      if (existing?.status === 'succeeded' && existing.result_json !== null) return JSON.parse(existing.result_json) as T;
      throw new Error('keeper operation already pending or failed');
    }
    try {
      const value = await request.work();
      await repository.finish(request.idempotencyKey, request.holder, 'succeeded', value, lease, request.now);
      return value;
    } catch (error) {
      await repository.finish(request.idempotencyKey, request.holder, 'failed', { error: error instanceof Error ? error.message : 'unknown' }, lease, request.now);
      throw error;
    }
  } finally {
    await repository.release(lease);
  }
}

export function keeperLeaseKey(kind: 'cleanup' | 'pyth' | 'commit' | 'funding' | 'expiry', market?: string): string {
  return market ? `keeper:${kind}:${market}` : `keeper:${kind}`;
}
import { ProtocolRepository } from './repositories';
