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

/** `TraderSeat` field byte offsets *relative to the seat's own start*,
 * verified against `programs/stockstream/src/state.rs::TraderSeat` via
 * `core::mem::offset_of!` (it is `#[repr(C, packed(8))]`, not tightly
 * packed -- hand-computing these from field sizes alone gives wrong
 * values once an `i128` field forces 8-byte alignment padding). */
const SEAT_FIELD_OFFSETS = {
  occupancy: 0,
  trader: 1,
  availableCollateral: 40,
  reservedMargin: 56,
  basePosition: 72,
  quoteEntryValue: 88,
  realizedPnl: 104,
  lastFundingAccumulator: 120,
  openBidExposure: 136,
  openAskExposure: 152,
  openOrderCount: 168,
  liquidationState: 172,
  sequence: 176,
} as const;

export interface TraderSeatProjection {
  seatIndex: number;
  owner: string;
  availableCollateral: bigint;
  reservedMargin: bigint;
  basePosition: bigint;
  quoteEntryValue: bigint;
  realizedPnl: bigint;
  lastFundingAccumulator: bigint;
  openBidExposure: bigint;
  openAskExposure: bigint;
  openOrderCount: number;
  liquidationState: number;
  sequence: bigint;
}

function readI128(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  const signBit = 1n << 127n;
  return value >= signBit ? value - (signBit << 1n) : value;
}

/**
 * Decodes the complete private per-trader projection for one seat directly
 * out of a market account's raw bytes: seat identity, position, entry
 * value, collateral, reserved margin, realized PnL, funding accumulator,
 * open exposure, order count, and liquidation status -- every
 * `TraderSeat` field this session's spec calls for except equity/
 * unrealized PnL, which are deliberately *not* computed here: that math
 * already exists once, authoritatively, in
 * `programs/stockstream/src/risk.rs::equity`/`unrealized_pnl`, and
 * reimplementing it a second time in TypeScript risks the two silently
 * diverging. A caller with the market's current oracle price can compute
 * them from these raw fields using the same formulas risk.rs documents.
 * Returns `null` for an out-of-range or unoccupied seat -- there is
 * nothing private to project for a seat nobody owns.
 */
export function decodeTraderSeatProjection(marketBytes: Uint8Array, seatIndex: number): TraderSeatProjection | null {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= MAX_TRADER_SEATS) return null;
  const start = TRADER_SEAT_OFFSET + seatIndex * TRADER_SEAT_SIZE;
  if (marketBytes.length < start + TRADER_SEAT_SIZE) return null;
  if (marketBytes[start + SEAT_FIELD_OFFSETS.occupancy] !== 1) return null;
  const view = new DataView(marketBytes.buffer, marketBytes.byteOffset, marketBytes.byteLength);
  return {
    seatIndex,
    owner: base58Encode(marketBytes.slice(start + SEAT_FIELD_OFFSETS.trader, start + SEAT_FIELD_OFFSETS.trader + 32)),
    availableCollateral: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.availableCollateral),
    reservedMargin: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.reservedMargin),
    basePosition: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.basePosition),
    quoteEntryValue: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.quoteEntryValue),
    realizedPnl: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.realizedPnl),
    lastFundingAccumulator: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.lastFundingAccumulator),
    openBidExposure: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.openBidExposure),
    openAskExposure: readI128(marketBytes, start + SEAT_FIELD_OFFSETS.openAskExposure),
    openOrderCount: view.getUint32(start + SEAT_FIELD_OFFSETS.openOrderCount, true),
    liquidationState: marketBytes[start + SEAT_FIELD_OFFSETS.liquidationState],
    sequence: view.getBigUint64(start + SEAT_FIELD_OFFSETS.sequence, true),
  };
}

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

  /** The wallet a live (non-revoked, unexpired) private session most
   * recently claimed for this seat -- used to route a projection update
   * to the right socket without a second on-chain read per event. This is
   * an approximation, not a re-verification of current on-chain ownership
   * (that already happened once, in `issuePrivateProjectionToken`, at
   * issuance time): if a seat changes owner without the old owner's
   * session ever being revoked, this can return a stale wallet until that
   * session expires. Acceptable for routing an update to a live socket --
   * `market-stream.ts`'s own `attachment.private` match (populated from
   * this same verified-at-connect-time session) is what actually gates
   * delivery, not this lookup. */
  async walletForSeat(marketPda: string, seatIndex: number, now: number): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT wallet FROM private_sessions
        WHERE market_pda = ? AND seat_index = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`)
      .bind(marketPda, seatIndex, now)
      .first<{ wallet: string }>();
    return row?.wallet ?? null;
  }
}

export class SeatOwnershipMismatch extends Error {
  constructor() { super("wallet does not own the requested trader seat"); }
}

/** Discriminators whose `events.rs` payload shape carries a single seat
 * index in its first two bytes (`payload_seat`/`payload_seat_amount`/
 * `payload_order`/`payload_position`/`payload_funding`/
 * `payload_liquidation`/`payload_session`) -- see
 * `clients/stockstream/src/index.ts`'s matching decoders, the source of
 * truth for every payload layout this function relies on. */
const SINGLE_SEAT_AT_OFFSET_ZERO = new Set([
  200, 201, // TraderSeatCreated, TraderSeatClosed
  202, 205, 206, 207, 208, 209, // OrderPlaced, OrderCancelled, CancelAllProgress, OrderReplaced, OrderExpired, InvalidOrderRemoved
  300, 301, 302, 303, 304, 305, // PositionChanged, MarginChanged, FundingAccumulatorUpdated, FundingSettled, LiquidationStarted, PositionLiquidated
  401, 402, 403, 404, 405, 406, // CollateralDeposited, CollateralWithdrawn, ProtocolFeesChanged, InsuranceFundChanged, BadDebtRecorded, BadDebtResolved
  700, 701, 702, 703, 704, // TradingSession*
]);
const FILL_DISCRIMINATORS = new Set([203, 204]); // OrderPartiallyFilled, OrderFilled

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Every trader seat a decoded StockStream event pertains to (a fill
 * touches two: maker and taker), or an empty array for a market-level
 * event with no single owning seat, or one carrying `NO_SEAT` (0xffff).
 * `payload` is the event's own base64-encoded 48-byte payload, exactly as
 * `event-decoder.ts` stores it on `MarketEvent.payload.payload`.
 */
export function seatsAffectedByEvent(discriminator: number, payloadBase64: string): number[] {
  const bytes = decodeBase64(payloadBase64);
  if (bytes.length < 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (FILL_DISCRIMINATORS.has(discriminator)) {
    const maker = view.getUint32(0, true);
    const taker = view.getUint32(4, true);
    return [maker, taker].filter((seat) => seat !== 0xffff_ffff);
  }
  if (SINGLE_SEAT_AT_OFFSET_ZERO.has(discriminator)) {
    const seat = view.getUint16(0, true);
    return seat === 0xffff ? [] : [seat];
  }
  return [];
}

export interface PrivateProjectionSink {
  publishPrivate(wallet: string, seatIndex: number, payload: unknown): void;
}

/**
 * Ties the pieces above together: decodes the projection for `seatIndex`
 * from the market's current raw bytes, resolves which wallet currently
 * holds a live private session for that seat, and pushes the projection
 * to `sink` (a `MarketStream` DO stub in production). A no-op (not an
 * error) when the seat is unoccupied or nobody currently holds a live
 * session for it -- there is no socket that could receive the update
 * either way.
 */
export async function publishSeatProjection(
  transport: SolanaL1Transport | MagicBlockErTransport,
  sessions: PrivateSessionRepository,
  sink: PrivateProjectionSink,
  marketPda: string,
  seatIndex: number,
  now: number,
): Promise<boolean> {
  const wallet = await sessions.walletForSeat(marketPda, seatIndex, now);
  if (!wallet) return false;
  const result = await transport.account(marketPda);
  if (!result.value?.data) return false;
  const projection = decodeTraderSeatProjection(base64ToBytes(result.value.data[0]), seatIndex);
  if (!projection) return false;
  sink.publishPrivate(wallet, seatIndex, projection);
  return true;
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
