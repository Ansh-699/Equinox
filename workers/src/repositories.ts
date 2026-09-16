export interface Lease { key: string; holder: string; fence: number; expiresAt: number }
export interface Operation { key: string; owner: string; request_hash: string; status: 'pending' | 'succeeded' | 'failed'; result_json: string | null }

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
