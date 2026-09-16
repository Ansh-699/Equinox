import { createHash } from "node:crypto";
import type { ApplicationSession } from "./session";
import { cleanupExpiredSessions, lookupSession, persistSession, revokeSession, touchSession, type SessionDatabase } from "./d1-session-store";

type BoundD1 = SessionDatabase;
const globalKey = "__STOCKSTREAM_D1__";
const developmentRows = new Map<string, ApplicationSession>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function developmentDatabase(): SessionDatabase {
  return { prepare(sql: string) {
    return { bind(...values: unknown[]) {
      return {
        async first<T>() {
          if (sql.startsWith("SELECT")) {
            const row = developmentRows.get(String(values[0]));
            return (row && row.revokedAt === null && row.expiresAt > Number(values[1]) ? row : null) as T | null;
          }
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT")) developmentRows.set(String(values[0]), { idHash: String(values[0]), privyUserId: String(values[1]), walletAddress: String(values[2]), createdAt: Number(values[3]), expiresAt: Number(values[4]), lastUsedAt: Number(values[5]), revokedAt: values[6] == null ? null : Number(values[6]), userAgentHash: String(values[7]) });
          if (sql.startsWith("UPDATE") && sql.includes("SET revoked_at")) { const row = developmentRows.get(String(values[2])); if (row) developmentRows.set(String(values[2]), { ...row, revokedAt: Number(values[0]), lastUsedAt: Number(values[1]) }); }
          if (sql.startsWith("UPDATE") && sql.includes("last_used_at = ? WHERE")) { const row = developmentRows.get(String(values[1])); if (row) developmentRows.set(String(values[1]), { ...row, lastUsedAt: Number(values[0]) }); }
          if (sql.startsWith("DELETE")) for (const [key, row] of developmentRows) if (row.expiresAt <= Number(values[0])) developmentRows.delete(key);
          return {};
        }
      };
    } };
  } };
}

export function routeSessionDatabase(): SessionDatabase {
  const bound = (globalThis as Record<string, unknown>)[globalKey] as BoundD1 | undefined;
  if (bound) return bound;
  if (process.env.NODE_ENV === "production") throw new Error("D1 session binding is unavailable");
  return developmentDatabase();
}

export async function storePersistentSession(db: SessionDatabase, raw: string, session: ApplicationSession) { await persistSession(db, raw, session); }
export async function readPersistentSession(db: SessionDatabase, raw: string | undefined, now = Date.now()) { return raw ? lookupSession(db, raw, now) : null; }
export async function revokePersistentSession(db: SessionDatabase, raw: string, now = Date.now()) { await revokeSession(db, raw, now); }
export async function touchPersistentSession(db: SessionDatabase, raw: string, now = Date.now()) { await touchSession(db, raw, now); }
export async function cleanupPersistentSessions(db: SessionDatabase, now = Date.now()) { await cleanupExpiredSessions(db, now); }
export { digest };
