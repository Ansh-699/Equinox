import type { SolanaL1Transport, MagicBlockErTransport } from "./chain-transports";

/** Priority 5, Section 7: private trader projections.
 *
 * Architecture choice (documented per the spec's requirement): **filtered,
 * authenticated private subscriptions over the existing `MarketStream`
 * Durable Object**, not a separate per-user Durable Object class. A
 * `MarketStream` instance already exists per market and already owns the
 * WebSocket connections for it; adding a verified-and-filtered private
 * channel to that same object is a smaller, lower-ceremony change than
 * introducing and wiring a whole second DO class (its own binding,
 * migration, and routing) for what is, per connection, a single extra
 * filter predicate. The tradeoff this accepts: a private subscriber's
 * connection lives in the same DO instance as the public room, so a
 * pathological public-room failure could in principle affect private
 * delivery too -- acceptable here since both already share the same
 * fate in production (one Worker, one market).
 *
 * Trust boundary: this module does not itself verify a Privy JWT (that
 * already happens in the Next.js app, `lib/auth/session.ts`). It assumes
 * whatever HTTP route calls `issuePrivateProjectionToken` has *already*
 * authenticated the caller and is asserting `wallet` truthfully (e.g. a
 * request from the Next.js backend carrying its own verified session, over
 * a shared secret or signed service-to-service call -- the concrete
 * transport of that assertion is a deployment detail outside this Worker's
 * boundary). What this module *does* verify, independently, is that the
 * asserted `wallet` is *actually* the on-chain owner of the seat it is
 * requesting a private feed for, by decoding the real `TraderSeat.trader`
 * field out of the market account -- an attacker who compromises the
 * "wallet" assertion for account A still cannot mint a token for someone
 * else's seat B.
 */

const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;
const MAX_TRADER_SEATS = 128;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 encoder (Bitcoin/Solana alphabet) for the one thing this
 * module needs -- turning a 32-byte on-chain pubkey into the address
 * string a caller would recognize -- without adding a dependency for it. */
function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  for (const byte of bytes) { if (byte !== 0) break; leadingZeros += 1; }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    out = BASE58_ALPHABET[Number(remainder)] + out;
  }
  return BASE58_ALPHABET[0].repeat(leadingZeros) + out;
}

/** Decodes seat `seatIndex`'s owner (`TraderSeat.trader`) directly out of
 * the real market account bytes, exactly at its packed offset
 * (`TRADER_SEAT_OFFSET + seatIndex * TRADER_SEAT_SIZE + 1` -- `occupancy`
 * is the seat's first byte, `trader` the next 32 -- see `state.rs`).
 * Returns `null` for an out-of-range or unoccupied seat.
 */
export async function seatOwner(
  transport: SolanaL1Transport | MagicBlockErTransport,
  marketPda: string,
  seatIndex: number,
): Promise<string | null> {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= MAX_TRADER_SEATS) return null;
  const result = await transport.account(marketPda);
  if (!result.value?.data) return null;
  const bytes = base64ToBytes(result.value.data[0]);
  const start = TRADER_SEAT_OFFSET + seatIndex * TRADER_SEAT_SIZE;
  if (bytes.length < start + TRADER_SEAT_SIZE) return null;
  if (bytes[start] !== 1) return null; // occupancy: 0 = empty seat, no owner
  return base58Encode(bytes.slice(start + 1, start + 33));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PrivateSession {
  wallet: string;
  marketPda: string;
  seatIndex: number;
}

/** Durable D1-backed private-projection session tokens. A token is opaque
 * to the holder; only its SHA-256 hash is ever stored, the same pattern
 * `lib/auth/d1-session-store.ts` uses on the Next.js side. */
export class PrivateSessionRepository {
  constructor(private readonly db: D1Database) {}

  async issue(wallet: string, marketPda: string, seatIndex: number, ttlMs: number, now: number): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = now + ttlMs;
    await this.db
      .prepare(`INSERT INTO private_sessions(token_hash, wallet, market_pda, seat_index, created_at, expires_at) VALUES (?,?,?,?,?,?)`)
      .bind(tokenHash, wallet, marketPda, seatIndex, now, expiresAt)
      .run();
    return { token, expiresAt };
  }

  /** Verifies a token for a specific market. A token issued for one market
   * is never valid against another, even before it expires -- cross-market
   * substitution is rejected explicitly, not merely by coincidence of
   * lookup keys. */
  async verify(token: string, marketPda: string, now: number): Promise<PrivateSession | null> {
    const tokenHash = await sha256Hex(token);
    const row = await this.db
      .prepare(`SELECT wallet, market_pda AS marketPda, seat_index AS seatIndex, expires_at AS expiresAt, revoked_at AS revokedAt
        FROM private_sessions WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<{ wallet: string; marketPda: string; seatIndex: number; expiresAt: number; revokedAt: number | null }>();
    if (!row || row.revokedAt !== null || row.expiresAt <= now || row.marketPda !== marketPda) return null;
    return { wallet: row.wallet, marketPda: row.marketPda, seatIndex: row.seatIndex };
  }

  async revoke(token: string, now: number): Promise<void> {
    const tokenHash = await sha256Hex(token);
    await this.db.prepare(`UPDATE private_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).bind(now, tokenHash).run();
  }
}

export class SeatOwnershipMismatch extends Error {
  constructor() { super("wallet does not own the requested trader seat"); }
}

/**
 * Issues a private-projection token, but only after independently
 * confirming (via a real on-chain account read, not the caller's
 * say-so) that `wallet` actually owns `seatIndex` on `marketPda`.
 */
export async function issuePrivateProjectionToken(
  repository: PrivateSessionRepository,
  transport: SolanaL1Transport | MagicBlockErTransport,
  wallet: string,
  marketPda: string,
  seatIndex: number,
  ttlMs: number,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const owner = await seatOwner(transport, marketPda, seatIndex);
  if (owner !== wallet) throw new SeatOwnershipMismatch();
  return repository.issue(wallet, marketPda, seatIndex, ttlMs, now);
}
