import { retryDelay } from './backoff';

export interface Lease { key: string; holder: string; fence: number; expiresAt: number }
export interface Operation { key: string; owner: string; request_hash: string; status: 'pending' | 'succeeded' | 'failed'; result_json: string | null }
export interface DurableCursor { marketPda: string; domain: 'l1' | 'er'; sequence: number; slot: number; updatedAt: number }
export type IndexedWrite = { kind: 'applied' } | { kind: 'duplicate' } | { kind: 'gap'; expected: number };
export interface DeadLetter { id: string; operation: string; payload: unknown; error: string; attempts: number; nextAttemptAt: number; createdAt: number }

function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid integer');
}
function expiry(now: number, ttl: number): number {
  integer(now); integer(ttl);
  if (ttl === 0) throw new Error('TTL must be positive');
  integer(now + ttl); return now + ttl;
}
function identifier(value: string): void {
  if (!value || value.length > 512) throw new Error('Invalid identifier');
}

export class ProtocolRepository {
  constructor(private readonly db: D1Database) {}

  async acquire(key: string, holder: string, ttl: number, now: number): Promise<Lease | null> {
    identifier(key); identifier(holder);
    const until = expiry(now, ttl);
    return this.db.prepare(`INSERT INTO keeper_leases(lease_key,holder,expires_at,updated_at,fence)
      VALUES(?,?,?,?,1) ON CONFLICT(lease_key) DO UPDATE SET holder=excluded.holder,
      expires_at=excluded.expires_at, updated_at=excluded.updated_at, fence=keeper_leases.fence+1
      WHERE keeper_leases.expires_at <= excluded.updated_at
      RETURNING lease_key AS key,holder,fence,expires_at AS expiresAt`).bind(key, holder, until, now).first<Lease>();
  }

  async renew(lease: Lease, ttl: number, now: number): Promise<Lease | null> {
    const until = expiry(now, ttl);
    return this.db.prepare(`UPDATE keeper_leases SET expires_at=?,updated_at=?
      WHERE lease_key=? AND holder=? AND fence=? AND expires_at>?
      RETURNING lease_key AS key,holder,fence,expires_at AS expiresAt`)
      .bind(until, now, lease.key, lease.holder, lease.fence, now).first<Lease>();
  }

  async release(lease: Lease): Promise<boolean> {
    // Retain the row so fence numbers never reset after release or expiration.
    const result = await this.db.prepare(`UPDATE keeper_leases SET expires_at=0
      WHERE lease_key=? AND holder=? AND fence=?`).bind(lease.key, lease.holder, lease.fence).run();
    return result.meta.changes === 1;
  }

  async reserve(key: string, owner: string, requestHash: string, ttl: number, now: number): Promise<boolean> {
    identifier(key); identifier(owner); identifier(requestHash);
    const until = expiry(now, ttl);
    const result = await this.db.prepare(`INSERT INTO operation_keys
      (key,owner,request_hash,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(key) DO NOTHING`).bind(key, owner, requestHash, now, until).run();
    return result.meta.changes === 1;
  }

  async operation(key: string): Promise<Operation | null> {
    return this.db.prepare('SELECT key,owner,request_hash,status,result_json FROM operation_keys WHERE key=?').bind(key).first<Operation>();
  }

  async finish(key: string, owner: string, status: 'succeeded' | 'failed', value: unknown, lease: Lease, now: number): Promise<void> {
    integer(now);
    const result = await this.db.prepare(`UPDATE operation_keys SET status=?,result_json=?
      WHERE key=? AND owner=? AND status='pending' AND EXISTS
      (SELECT 1 FROM keeper_leases WHERE lease_key=? AND holder=? AND fence=? AND expires_at>?)`)
      .bind(status, JSON.stringify(value), key, owner, lease.key, lease.holder, lease.fence, now).run();
    if (result.meta.changes !== 1) throw new Error('Operation ownership or lease lost');
  }

  async allow(key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    identifier(key); integer(limit); const until = expiry(now, windowMs);
    if (limit === 0) return false;
    const row = await this.db.prepare(`INSERT INTO rate_limits(key,window_start,count,expires_at)
      VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE rate_limits.count+1 END,
      window_start=CASE WHEN rate_limits.expires_at<=? THEN excluded.window_start ELSE rate_limits.window_start END,
      expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END
      WHERE rate_limits.expires_at<=? OR rate_limits.count<? RETURNING count`)
      .bind(key, now, until, now, now, now, now, limit).first<{count: number}>();
    return row !== null;
  }

  async cleanup(now: number): Promise<void> {
    integer(now);
    await this.db.batch([
      this.db.prepare('DELETE FROM application_sessions WHERE expires_at<=?').bind(now),
      this.db.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(now),
      // Pending outcomes are ambiguous: expiry must not authorize a duplicate submission.
      this.db.prepare("DELETE FROM operation_keys WHERE expires_at<=? AND status!='pending'").bind(now),
    ]);
  }
}

/** Durable D1 projection store. A later delta is rejected until its market is
 * resnapshotted, rather than being applied over an unreconciled sequence gap. */
export class IndexerRepository {
  constructor(private readonly db: D1Database) {}

  async cursor(marketPda: string, domain: 'l1' | 'er'): Promise<DurableCursor | null> {
    return this.db.prepare(`SELECT market_pda AS marketPda,domain,sequence,slot,updated_at AS updatedAt
      FROM indexer_cursors WHERE market_pda=? AND domain=?`).bind(marketPda, domain).first<DurableCursor>();
  }

  async append(marketPda: string, domain: 'l1' | 'er', sequence: number, slot: number, id: string, event: unknown, now: number): Promise<IndexedWrite> {
    identifier(marketPda); identifier(id); integer(sequence); integer(slot); integer(now);
    if (sequence === 0) throw new Error('Sequence must be positive');
    const duplicate = await this.db.prepare('SELECT 1 AS present FROM indexed_events WHERE event_id=?').bind(id).first<{ present: number }>();
    if (duplicate) return { kind: 'duplicate' };
    const current = await this.cursor(marketPda, domain);
    const expected = (current?.sequence ?? 0) + 1;
    if (sequence !== expected) return { kind: 'gap', expected };
    const statements = [
      this.db.prepare(`INSERT INTO indexed_events(event_id,market_pda,domain,sequence,event_json,observed_at)
        VALUES(?,?,?,?,?,?)`).bind(id, marketPda, domain, sequence, JSON.stringify(event), now),
      current
        ? this.db.prepare(`UPDATE indexer_cursors SET sequence=?,slot=?,updated_at=?
            WHERE market_pda=? AND domain=? AND sequence=?`).bind(sequence, slot, now, marketPda, domain, current.sequence)
        : this.db.prepare(`INSERT INTO indexer_cursors(market_pda,domain,sequence,slot,updated_at)
            VALUES(?,?,?,?,?)`).bind(marketPda, domain, sequence, slot, now),
    ];
    const results = await this.db.batch(statements);
    if (current && results[1].meta.changes !== 1) throw new Error('Indexer cursor contention; resnapshot required');
    return { kind: 'applied' };
  }

  async replaceSnapshot(marketPda: string, domain: 'l1' | 'er', sequence: number, slot: number, snapshot: unknown, now: number): Promise<void> {
    identifier(marketPda); integer(sequence); integer(slot); integer(now);
    await this.db.batch([
      this.db.prepare(`INSERT INTO market_snapshots(market_pda,domain,sequence,snapshot_json,observed_at)
        VALUES(?,?,?,?,?) ON CONFLICT(market_pda,domain) DO UPDATE SET
        sequence=excluded.sequence,snapshot_json=excluded.snapshot_json,observed_at=excluded.observed_at`)
        .bind(marketPda, domain, sequence, JSON.stringify(snapshot), now),
      this.db.prepare(`INSERT INTO indexer_cursors(market_pda,domain,sequence,slot,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(market_pda,domain) DO UPDATE SET
        sequence=excluded.sequence,slot=excluded.slot,updated_at=excluded.updated_at`)
        .bind(marketPda, domain, sequence, slot, now),
    ]);
  }

  async snapshot(marketPda: string, domain: 'l1' | 'er'): Promise<{ sequence: number; snapshot: unknown } | null> {
    const row = await this.db.prepare('SELECT sequence,snapshot_json FROM market_snapshots WHERE market_pda=? AND domain=?').bind(marketPda, domain).first<{ sequence: number; snapshot_json: string }>();
    return row ? { sequence: row.sequence, snapshot: JSON.parse(row.snapshot_json) } : null;
  }
}

/** Priority 6: a durable dead-letter queue for keeper work that failed.
 * `dead_letters` (migration `0003_protocol_projection.sql`) previously had
 * no code path writing to or reading from it at all. `record` schedules
 * the next retry with `keepers.ts::retryDelay`'s bounded exponential
 * backoff; `resolve` clears an entry once its operation finally succeeds
 * (a later success always wins over an earlier recorded failure -- this
 * is a queue of "still needs another attempt", not a permanent failure
 * log). `giveUp` marks an entry as exhausted after too many attempts,
 * removing it from the retry sweep's `due()` query without deleting the
 * record, so it stays visible for manual/operator inspection. */
export class DeadLetterRepository {
  constructor(private readonly db: D1Database) {}

  async record(id: string, operation: string, payload: unknown, error: string, now: number): Promise<{ attempts: number; nextAttemptAt: number }> {
    identifier(id); identifier(operation);
    const existing = await this.db.prepare('SELECT attempts FROM dead_letters WHERE id=?').bind(id).first<{ attempts: number }>();
    const attempts = (existing?.attempts ?? 0) + 1;
    const nextAttemptAt = now + retryDelay(attempts);
    await this.db
      .prepare(`INSERT INTO dead_letters(id, operation, payload_json, error, attempts, next_attempt_at, created_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET operation=excluded.operation, payload_json=excluded.payload_json,
          error=excluded.error, attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at`)
      .bind(id, operation, JSON.stringify(payload), error, attempts, nextAttemptAt, now)
      .run();
    return { attempts, nextAttemptAt };
  }

  async due(now: number, limit = 50): Promise<DeadLetter[]> {
    const result = await this.db
      .prepare(`SELECT id, operation, payload_json AS payloadJson, error, attempts, next_attempt_at AS nextAttemptAt, created_at AS createdAt
        FROM dead_letters WHERE next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`)
      .bind(now, limit)
      .all<{ id: string; operation: string; payloadJson: string; error: string; attempts: number; nextAttemptAt: number; createdAt: number }>();
    return result.results.map((row) => ({ id: row.id, operation: row.operation, payload: JSON.parse(row.payloadJson), error: row.error, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, createdAt: row.createdAt }));
  }

  async resolve(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM dead_letters WHERE id=?').bind(id).run();
  }

  /** Pushes `nextAttemptAt` far into the future rather than deleting the
   * row: the failure stays on record for an operator to find, but the
   * retry sweep stops picking it up every tick. */
  async giveUp(id: string, until: number): Promise<void> {
    await this.db.prepare('UPDATE dead_letters SET next_attempt_at=? WHERE id=?').bind(until, id).run();
  }
}

export type TxAttemptStatus = 'submitted' | 'confirmed' | 'finalized' | 'failed' | 'expired' | 'timeout';
export interface TxAttempt {
  id: string;
  keeper: string;
  marketPda: string;
  domain: 'l1' | 'er';
  signature: string | null;
  status: TxAttemptStatus;
  error: string | null;
  submittedAt: number;
  resolvedAt: number | null;
}

/** Priority 8: durable record of every transaction a keeper job submits,
 * independent of the generic `operation_keys` idempotency ledger -- this
 * is an audit trail keyed by keeper+market (many attempts per idempotency
 * key are expected: a blockhash-expired attempt is resubmitted under a
 * fresh signature but the same logical operation), not a replay guard. */
export class TxAttemptRepository {
  constructor(private readonly db: D1Database) {}

  async submitted(id: string, keeper: string, marketPda: string, domain: 'l1' | 'er', signature: string, now: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO tx_attempts(id,keeper,market_pda,domain,signature,status,submitted_at)
        VALUES(?,?,?,?,?,'submitted',?)`)
      .bind(id, keeper, marketPda, domain, signature, now)
      .run();
  }

  async resolved(id: string, status: Exclude<TxAttemptStatus, 'submitted'>, error: string | null, now: number): Promise<void> {
    await this.db.prepare('UPDATE tx_attempts SET status=?,error=?,resolved_at=? WHERE id=?').bind(status, error, now, id).run();
  }

  async recentForMarket(marketPda: string, keeper: string, limit = 20): Promise<TxAttempt[]> {
    const result = await this.db
      .prepare(`SELECT id,keeper,market_pda AS marketPda,domain,signature,status,error,submitted_at AS submittedAt,resolved_at AS resolvedAt
        FROM tx_attempts WHERE market_pda=? AND keeper=? ORDER BY submitted_at DESC LIMIT ?`)
      .bind(marketPda, keeper, limit)
      .all<TxAttempt>();
    return result.results;
  }
}

/** Wires up `oracle_updates` (0003_protocol_projection.sql), previously
 * declared but never written to. `dedupe` is the Pyth keeper's own
 * defense against resubmitting a feed update it has already acted on --
 * independent of `lib/server/pyth-keeper.ts::PythKeeper`'s in-memory
 * `lastTimestamp`/`lastHash` check, which does not survive a Worker
 * restart or a second isolate. */
export class OracleUpdateRepository {
  constructor(private readonly db: D1Database) {}

  async alreadyApplied(marketPda: string, timestamp: number, payloadHash: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT payload_hash AS payloadHash FROM oracle_updates WHERE market_pda=? AND timestamp=?')
      .bind(marketPda, timestamp)
      .first<{ payloadHash: string }>();
    return row !== null && row.payloadHash === payloadHash;
  }

  async record(marketPda: string, feedId: string, timestamp: number, payloadHash: string, status: 'submitted' | 'confirmed' | 'rejected', now: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO oracle_updates(market_pda,feed_id,timestamp,payload_hash,status,observed_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(market_pda,timestamp) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at`)
      .bind(marketPda, feedId, timestamp, payloadHash, status, now)
      .run();
  }
}

/** Wires up `commit_records` (0003_protocol_projection.sql), previously
 * declared but never written to. One row per commit *sequence* attempted
 * for a market, so the MagicBlock commit keeper can tell "have I already
 * requested this sequence" apart from "is this sequence confirmed yet"
 * without re-deriving it from `tx_attempts`. */
export class CommitRecordRepository {
  constructor(private readonly db: D1Database) {}

  async lastRequestedSequence(marketPda: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT MAX(sequence) AS sequence FROM commit_records WHERE market_pda=?')
      .bind(marketPda)
      .first<{ sequence: number | null }>();
    return row?.sequence ?? 0;
  }

  async record(marketPda: string, sequence: number, domain: 'l1' | 'er', status: 'requested' | 'confirmed' | 'finalized' | 'failed', signature: string | null, now: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO commit_records(market_pda,sequence,domain,status,signature,observed_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(market_pda,sequence) DO UPDATE SET status=excluded.status,signature=excluded.signature,observed_at=excluded.observed_at`)
      .bind(marketPda, sequence, domain, status, signature, now)
      .run();
  }
}

/** Durable continuation cursor for a bounded, resumable sweep (the
 * expiry/invalid-order cleanup keeper's own requirement: "persist a
 * continuation cursor; resume after restart" rather than always
 * restarting a sweep from the beginning). `cursor` is opaque JSON --
 * whatever shape the keeper that owns it needs (e.g. `{ seatIndex }`). */
export class KeeperCursorRepository {
  constructor(private readonly db: D1Database) {}

  async get(keeper: string, marketPda: string): Promise<unknown | null> {
    const row = await this.db.prepare('SELECT cursor_json AS cursorJson FROM keeper_cursors WHERE keeper=? AND market_pda=?').bind(keeper, marketPda).first<{ cursorJson: string }>();
    return row ? JSON.parse(row.cursorJson) : null;
  }

  async set(keeper: string, marketPda: string, cursor: unknown, now: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO keeper_cursors(keeper,market_pda,cursor_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(keeper,market_pda) DO UPDATE SET cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`)
      .bind(keeper, marketPda, JSON.stringify(cursor), now)
      .run();
  }
}

