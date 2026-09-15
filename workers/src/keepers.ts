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
