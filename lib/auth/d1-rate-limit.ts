import { createHash } from 'node:crypto';
import type { SessionDatabase } from './d1-session-store';

export async function allowSessionExchange(db: SessionDatabase, client: string, now = Date.now()): Promise<boolean> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid timestamp');
  const key = `auth:${createHash('sha256').update(client).digest('hex')}`;
  const row = await db.prepare(`INSERT INTO rate_limits(key,window_start,count,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE rate_limits.count+1 END,
    window_start=CASE WHEN rate_limits.expires_at<=? THEN excluded.window_start ELSE rate_limits.window_start END,
    expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END
    WHERE rate_limits.expires_at<=? OR rate_limits.count<10 RETURNING count`)
    .bind(key, now, now+60_000, now, now, now, now).first<{count:number}>();
  return row !== null;
}
