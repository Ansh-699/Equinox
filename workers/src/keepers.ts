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

export { retryDelay } from './backoff';

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

export function keeperLeaseKey(kind: 'cleanup' | 'pyth' | 'commit' | 'funding' | 'expiry' | 'ingestion' | 'session', market?: string): string {
  return market ? `keeper:${kind}:${market}` : `keeper:${kind}`;
}

export interface DurableKeeperWithDeadLetterRequest<T> extends DurableKeeperRequest<T> {
  /** Stable identity for this specific piece of work (not the keeper kind
   * itself) -- e.g. `funding:<marketPda>:<epochMs>` -- so a dead-letter
   * entry tracks retries of *this* attempt, not the keeper's lease/tick
   * identity in general. */
  deadLetterId: string;
  /** After this many recorded failures, `giveUp` is called instead of
   * scheduling yet another retry -- an operator has to look at it. */
  maxAttempts?: number;
}

/**
 * `runDurableKeeper` plus a durable dead-letter record: on failure, the
 * work is *also* recorded in `dead_letters` with a scheduled retry time
 * (`repositories.ts::DeadLetterRepository`), and on success any prior
 * dead-letter record for the same `deadLetterId` is cleared. The error
 * still propagates to the caller exactly as `runDurableKeeper` already
 * does -- this only adds durable retry bookkeeping, it does not swallow
 * the failure.
 */
export async function runDurableKeeperWithDeadLetter<T>(
  repository: ProtocolRepository,
  deadLetters: DeadLetterRepository,
  request: DurableKeeperWithDeadLetterRequest<T>,
): Promise<T> {
  try {
    const value = await runDurableKeeper(repository, request);
    await deadLetters.resolve(request.deadLetterId);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { attempts } = await deadLetters.record(request.deadLetterId, request.leaseKey, { idempotencyKey: request.idempotencyKey }, message, request.now);
    if (attempts >= (request.maxAttempts ?? 10)) await deadLetters.giveUp(request.deadLetterId, request.now + 365 * 24 * 60 * 60 * 1000);
    throw error;
  }
}

import { ProtocolRepository, DeadLetterRepository } from './repositories';
