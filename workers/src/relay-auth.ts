import { address, getBase58Decoder, getBase58Encoder, getProgramDerivedAddress } from "@solana/kit";
import type { V3CoreState, V3SeatPositionState } from "./v3-market-state";

/**
 * Authoritative session-relay authentication.
 *
 * The relayer must verify every claim independently before sponsoring:
 * the Privy identity actually controls the claimed wallet, that wallet
 * actually owns the claimed trader seat, a real TradingSession PDA exists
 * for the exact (owner, market, seat, signer) tuple and is not expired or
 * revoked, its action allowlist covers the instruction being relayed, and
 * its on-chain nonce matches the one the transaction is about to consume.
 * Fail closed on every step.
 *
 * The PrivyVerifier interface is injected by the caller so @privy-io/node
 * stays out of the main Worker bundle (which would break Miniflare tests).
 * All chain reads are done by the caller passing authoritative bytes --
 * this module never fetches anything itself, so it stays trivially
 * testable and has no RPC/D1 dependency of its own.
 */

export interface PrivyVerifier {
  /** `solanaWallets` must be the user's actual linked Solana wallet
   * addresses (e.g. from a `client.users()._get(user_id)` lookup), not
   * merely claims lifted from the token payload itself -- the token proves
   * an identity, not a wallet, so wallet ownership has to be checked
   * against the user's real linked-accounts record. */
  verify(token: string): Promise<{ user_id: string; app_id?: string; solanaWallets: string[] }>;
}

/** Verifies the Privy identity AND that it actually controls `expectedWallet`
 * -- a valid token for user A asserting wallet B (a wallet A never linked)
 * must be rejected here, not merely trusted because the token itself
 * verified. */
export async function verifyPrivyToken(
  token: string,
  appId: string,
  expectedWallet: string,
  verifier: PrivyVerifier,
): Promise<{ userId: string } | { error: string }> {
  try {
    const verified = await verifier.verify(token);
    if (!verified.user_id) return { error: "privy_no_user_id" };
    if (verified.app_id && verified.app_id !== appId) return { error: "privy_wrong_audience" };
    if (!verified.solanaWallets.includes(expectedWallet)) return { error: "privy_wallet_not_linked" };
    return { userId: verified.user_id };
  } catch {
    return { error: "privy_verification_failed" };
  }
}

const MARKET_ACCOUNT_SIZE = 222_752;
const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;

const TRADING_SESSION_SIZE = 256;
const TRADING_SESSION_SEED = new TextEncoder().encode("trading_session");

/** `SESSION_ACTION_*` bits, mirrored from `programs/equinox/src/session.rs`
 * and `clients/equinox/src/abi/sessions.ts` -- never hand-guessed. */
export const SESSION_ACTION = {
  place: 1 << 0,
  cancel: 1 << 1,
  cancelAll: 1 << 2,
  replace: 1 << 3,
  reduceOnlyClose: 1 << 4,
} as const;

/** The `required_actions` bitmask each session-relayable opcode's own
 * on-chain handler computes (`handlers.rs::authorize_trading_actor`
 * call sites) -- `placeOrder` additionally accepts `reduceOnlyClose` alone
 * when the order carries the reduce-only flag (order data byte 3, bit
 * `0x4`), matching `handlers.rs`'s `order.flags & 4 != 0` branch exactly. */
export function requiredSessionActions(opcode: number, placeOrderFlags: number): number {
  switch (opcode) {
    case 3: // PlaceOrder
      return (placeOrderFlags & 4) !== 0 ? SESSION_ACTION.place | SESSION_ACTION.reduceOnlyClose : SESSION_ACTION.place;
    case 4: // CancelOrder
      return SESSION_ACTION.cancel;
    case 5: // CancelAll
      return SESSION_ACTION.cancelAll;
    case 33: // ReplaceOrder
      return SESSION_ACTION.replace;
    default:
      return 0;
  }
}

export async function deriveTradingSessionAddress(
  owner: string,
  market: string,
  seatIndex: number,
  sessionSigner: string,
  programId: string,
): Promise<string> {
  const seatIndexBytes = Uint8Array.of(seatIndex & 0xff, (seatIndex >> 8) & 0xff);
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [
      TRADING_SESSION_SEED,
      base58ToBytes(owner),
      base58ToBytes(market),
      seatIndexBytes,
      base58ToBytes(sessionSigner),
    ],
  });
  return pda;
}

/** @solana/kit's base58 encoder produces exactly the 32 raw bytes for a
 * well-formed address string -- used here purely as a decode-to-bytes step
 * for PDA seed material, never as an on-chain instruction encoder. */
function base58ToBytes(value: string): Uint8Array {
  return getBase58Encoder().encode(value) as Uint8Array;
}

export interface VerifyTradingSessionInput {
  marketBytes: Uint8Array;
  /** `null` when the account doesn't exist (never created, or wrong PDA). */
  sessionBytes: Uint8Array | null;
  /** The on-chain `owner` field of the fetched session account, as RPC
   * reports it -- `null` when the account doesn't exist. Must be the
   * Equinox program; nothing else could have written this layout at
   * this exact derived address regardless of its byte contents. */
  sessionAccountOwner: string | null;
  ownerWallet: string;
  sessionSignerAddress: string;
  seatIndex: number;
  marketPda: string;
  programId: string;
  /** The nonce this transaction's own instruction is about to consume,
   * extracted from the real transaction bytes (never a client-asserted
   * field) -- see `session-relayer.ts`'s `validateSessionTransaction`. */
  actionNonce: bigint;
  /** The opcode this transaction's own instruction targets, likewise
   * extracted from the real transaction bytes. */
  opcode: number;
  /** `PlaceOrder`'s flags byte when `opcode` is `PlaceOrder`/`ReplaceOrder`,
   * needed to compute the reduce-only-only allowance; `0` otherwise. */
  placeOrderFlags: number;
  now: Date;
  /** V3 replaces the V2 monolithic arena with a validated core + seat
   * shard. When present, this is the only seat source accepted; omitting it
   * for a V3 core fails closed rather than interpreting V3 bytes as V2. */
  v3?: { core: V3CoreState; seat: V3SeatPositionState | null };
  domain?: "l1" | "er";
  /** Order fields decoded from the signed instruction. Required for V3
   * PlaceOrder/ReplaceOrder so sponsorship applies the same limits as the
   * on-chain handler before paying fees. */
  orderIntent?: { quantity: bigint; priceOrOffset: bigint; side: 0 | 1; tree: 0 | 1; reduceOnly: boolean; replace: boolean };
}

/** Full authoritative chain: market sanity, seat ownership, and a real
 * TradingSession PDA's identity/expiry/revocation/allowlist/nonce -- every
 * field checked against genuine on-chain bytes this call was handed, never
 * inferred from the caller's own claims. */
export function verifyTradingSession(input: VerifyTradingSessionInput): { ok: true } | { ok: false; reason: string } {
  const market = input.marketBytes;
  if (input.v3) {
    const { core, seat } = input.v3;
    if (market.length !== 4_096 || core.kind !== "v3") return { ok: false, reason: "v3_core_wrong_size" };
    if (core.mode !== 1 && core.mode !== 2 && core.mode !== 3) return { ok: false, reason: "market_not_open" };
    if (!core.oracleValid) return { ok: false, reason: "oracle_not_valid" };
    if (!seat) return { ok: false, reason: "seat_not_occupied" };
    if (seat.slot !== input.seatIndex || seat.trader !== input.ownerWallet) return { ok: false, reason: "seat_owner_mismatch" };
  } else if (market.length === 4_096) {
    return { ok: false, reason: "v3_context_required" };
  }
  if (!input.v3 && market.length !== MARKET_ACCOUNT_SIZE) return { ok: false, reason: "market_wrong_size" };
  if (!input.v3 && market[10] !== 1) return { ok: false, reason: "market_not_initialized" };
  if (!input.v3 && market[11] !== 1) return { ok: false, reason: "market_not_open" };
  if (!input.v3 && market[294] !== 1) return { ok: false, reason: "oracle_not_valid" };

  if (!Number.isInteger(input.seatIndex) || input.seatIndex < 0) return { ok: false, reason: "seat_index_invalid" };
  if (!input.v3) {
    const seatBase = TRADER_SEAT_OFFSET + input.seatIndex * TRADER_SEAT_SIZE;
    if (seatBase + TRADER_SEAT_SIZE > market.length) return { ok: false, reason: "seat_out_of_bounds" };
    if (market[seatBase] !== 1) return { ok: false, reason: "seat_not_occupied" };
    const seatTrader = getBase58Decoder().decode(market.subarray(seatBase + 1, seatBase + 33));
    if (seatTrader !== input.ownerWallet) return { ok: false, reason: "seat_owner_mismatch" };
  }

  if (!input.sessionBytes || input.sessionAccountOwner !== input.programId) {
    return { ok: false, reason: "session_not_found" };
  }
  const session = input.sessionBytes;
  if (session.length !== TRADING_SESSION_SIZE) return { ok: false, reason: "session_wrong_size" };
  const discriminator = new TextDecoder().decode(session.subarray(0, 8));
  const view = new DataView(session.buffer, session.byteOffset, session.byteLength);
  if (discriminator !== "STKSES02" || view.getUint16(8, true) !== 1) {
    return { ok: false, reason: "session_bad_discriminator" };
  }
  if (session[10] !== 1) return { ok: false, reason: "session_not_initialized" };
  if (session[11] !== 0) return { ok: false, reason: "session_revoked" };

  const sessionOwner = getBase58Decoder().decode(session.subarray(12, 44));
  if (sessionOwner !== input.ownerWallet) return { ok: false, reason: "session_owner_mismatch" };
  const sessionSigner = getBase58Decoder().decode(session.subarray(44, 76));
  if (sessionSigner !== input.sessionSignerAddress) return { ok: false, reason: "session_signer_mismatch" };
  const targetProgram = getBase58Decoder().decode(session.subarray(76, 108));
  if (targetProgram !== input.programId) return { ok: false, reason: "session_wrong_program" };
  const sessionMarket = getBase58Decoder().decode(session.subarray(108, 140));
  if (sessionMarket !== input.marketPda) return { ok: false, reason: "session_wrong_market" };
  if (view.getUint16(140, true) !== input.seatIndex) return { ok: false, reason: "session_wrong_seat" };

  const expiresAt = view.getBigUint64(150, true);
  const nowSeconds = BigInt(Math.floor(input.now.getTime() / 1000));
  if (expiresAt <= nowSeconds) return { ok: false, reason: "session_expired" };

  const required = requiredSessionActions(input.opcode, input.placeOrderFlags);
  if (required === 0) return { ok: false, reason: "opcode_not_session_relayable" };
  const actions = session[158];
  if ((actions & required) === 0) return { ok: false, reason: "session_action_not_allowed" };

  const nextExpectedNonce = view.getBigUint64(201, true);
  if (nextExpectedNonce !== input.actionNonce) return { ok: false, reason: "session_nonce_mismatch" };

  if (input.v3 && input.orderIntent) {
    const { core, seat } = input.v3;
    if (!seat) return { ok: false, reason: "seat_not_occupied" };
    const { quantity, priceOrOffset, side, tree, reduceOnly, replace } = input.orderIntent;
    const effectivePrice = tree === 0 ? priceOrOffset : core.lastVerifiedOraclePrice + priceOrOffset;
    if (effectivePrice <= 0n) return { ok: false, reason: "order_price_invalid" };
    const notional = quantity * effectivePrice;
    if (notional <= 0n || notional > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "order_notional_invalid" };
    const signedQuantity = side === 0 ? quantity : -quantity;
    const resultingPosition = seat.basePosition + signedQuantity;
    const resultingExposure = resultingPosition < 0n ? -resultingPosition : resultingPosition;
    if (reduceOnly && (seat.basePosition === 0n || resultingExposure >= (seat.basePosition < 0n ? -seat.basePosition : seat.basePosition))) {
      return { ok: false, reason: "reduce_only_would_not_reduce" };
    }
    const maxOrderNotional = view.getBigUint64(159, true);
    const maxCumulativeNotional = view.getBigUint64(167, true);
    const consumedCumulativeNotional = view.getBigUint64(175, true);
    const maxExposure = (() => {
      const raw = view.getBigUint64(183, true) | (view.getBigUint64(191, true) << 64n);
      return raw >= (1n << 127n) ? raw - (1n << 128n) : raw;
    })();
    const maxOpenOrders = view.getUint16(199, true);
    if (notional > maxOrderNotional || notional + consumedCumulativeNotional > maxCumulativeNotional) {
      return { ok: false, reason: "session_notional_limit" };
    }
    if (maxExposure < 0n || resultingExposure > maxExposure) return { ok: false, reason: "session_exposure_limit" };
    const projectedOpenOrders = seat.openOrderCount - (replace && seat.openOrderCount > 0 ? 1 : 0);
    if (projectedOpenOrders >= maxOpenOrders) return { ok: false, reason: "session_open_order_limit" };
  }

  if (input.v3 && input.domain) {
    const delegated = input.v3.core.delegationStatus === 1 || input.v3.core.delegationStatus === 2;
    if ((input.domain === "er") !== delegated) return { ok: false, reason: "relay_domain_mismatch" };
  }

  return { ok: true };
}
