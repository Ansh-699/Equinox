/** Registry of Meteora DBC launches made through StockStream, for the Launch
 * page's list. Display data only: every number shown is read from the chain. */

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

export interface LaunchRow { pool: string; baseMint: string; symbol: string; name: string; preset: string; createdAt: number }

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A registration body, or why it is refused. */
export function parseLaunch(body: unknown, now: number): LaunchRow | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof b[key] === "string" ? (b[key] as string).trim().slice(0, max) : "");
  const row = { pool: text("pool", 44), baseMint: text("baseMint", 44), symbol: text("symbol", 64).toUpperCase(), name: text("name", 40), preset: text("preset", 20), createdAt: now };
  if (!BASE58.test(row.pool) || !BASE58.test(row.baseMint)) return { error: "pool and baseMint must be addresses" };
  if (!/^[A-Z0-9]{2,10}$/.test(row.symbol) || !row.name) return { error: "name and a 2-10 character symbol are required" };
  return row;
}

type Rpc = { call<T>(method: string, params: unknown[]): Promise<T> };

export async function registerLaunch(db: D1Database, rpc: Rpc, body: unknown, now = Date.now()): Promise<{ status: number; body: unknown }> {
  const row = parseLaunch(body, now);
  if ("error" in row) return { status: 400, body: row };
  // Only real DBC pools: the account must exist and belong to the DBC program.
  const info = await rpc.call<{ value: { owner: string } | null }>("getAccountInfo", [row.pool, { encoding: "base64", commitment: "confirmed" }]);
  if (info.value?.owner !== DBC_PROGRAM_ID) return { status: 400, body: { error: "not a Meteora DBC pool" } };
  await db.prepare("INSERT OR IGNORE INTO launches (pool, base_mint, symbol, name, preset, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.pool, row.baseMint, row.symbol, row.name, row.preset, row.createdAt).run();
  return { status: 200, body: { ok: true } };
}

export async function listLaunches(db: D1Database): Promise<LaunchRow[]> {
  const { results } = await db.prepare("SELECT pool, base_mint AS baseMint, symbol, name, preset, created_at AS createdAt FROM launches ORDER BY created_at DESC LIMIT 50").all<LaunchRow>();
  return results;
}
