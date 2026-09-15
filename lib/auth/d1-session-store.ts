import { createHash } from "node:crypto";
import type { ApplicationSession } from "./session";

export interface SessionDatabase { prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } }; }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const sessionSchema = `CREATE TABLE IF NOT EXISTS application_sessions (id_hash TEXT PRIMARY KEY, privy_user_id TEXT NOT NULL, wallet_address TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER, user_agent_hash TEXT NOT NULL);`;
export async function persistSession(db: SessionDatabase, rawCookie: string, session: ApplicationSession): Promise<void> {
  await db.prepare("INSERT INTO application_sessions (id_hash, privy_user_id, wallet_address, created_at, expires_at, last_used_at, revoked_at, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(digest(rawCookie), session.privyUserId, session.walletAddress, session.createdAt, session.expiresAt, session.lastUsedAt, session.revokedAt, session.userAgentHash).run();
}
export async function lookupSession(db: SessionDatabase, rawCookie: string, now = Date.now()): Promise<ApplicationSession | null> {
  const row = await db.prepare("SELECT id_hash as idHash, privy_user_id as privyUserId, wallet_address as walletAddress, created_at as createdAt, expires_at as expiresAt, last_used_at as lastUsedAt, revoked_at as revokedAt, user_agent_hash as userAgentHash FROM application_sessions WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ?").bind(digest(rawCookie), now).first<ApplicationSession>();
  return row;
}
export async function revokeSession(db: SessionDatabase, rawCookie: string, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE application_sessions SET revoked_at = ?, last_used_at = ? WHERE id_hash = ?").bind(now, now, digest(rawCookie)).run();
}
export async function touchSession(db: SessionDatabase, rawCookie: string, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE application_sessions SET last_used_at = ? WHERE id_hash = ? AND revoked_at IS NULL").bind(now, digest(rawCookie)).run();
}
export async function cleanupExpiredSessions(db: SessionDatabase, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM application_sessions WHERE expires_at <= ?").bind(now).run();
}
