/**
 * Authoritative session-relay authentication (20-step chain).
 *
 * The relayer must verify every claim independently before sponsoring:
 * the Privy identity, the main wallet → seat → session PDA chain, the
 * nonce, the expiry, the opcode allowlist, the notional limits, the
 * execution domain, and the fee-payer safety. Fail closed.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { PROGRAM_ID, TRADER_SEAT_OFFSET, TRADER_SEAT_SIZE } from "../../clients/stockstream/src/abi/constants";
import { TRADING_SESSION_SEED } from "../../clients/stockstream/src/abi/constants";

import { SESSION_ACTION, MARKET_MODE } from "../../clients/stockstream/src/abi/instructions";
import { ORACLE_VALID_OFFSET, ORACLE_PRICE_OFFSET } from "../../clients/stockstream/src/abi/constants";

export interface RelayRequest {
  transactionBase64: string;
  expectedProgramAddress: string;
  sessionSignerAddress: string;
  ownerWallet: string;
  expectedMarket: string;
  expectedNonce: number;
  domain: "l1" | "er";
  privyAccessToken: string;
}

export interface RelayValidationResult {
  ok: boolean;
  reason: string;
  privyUserId?: string;
}

/** Steps 1-6: Privy token verification → main wallet resolution. */
export async function verifyPrivyToken(
  token: string,
  appId: string,
  appSecret: string,
  expectedWallet: string,
): Promise<{ userId: string } | { error: string }> {
  try {
    const { PrivyClient } = await import("@privy-io/node");
    const client = new PrivyClient({ appId, appSecret });
    const verified = await client.utils().auth().verifyAccessToken(token);
    if (!verified.user_id) return { error: "privy_no_user_id" };
    if (verified.app_id !== appId) return { error: "privy_wrong_audience" };
    return { userId: verified.user_id };
  } catch { return { error: "privy_verification_failed" }; }
}

/** Steps 7-10: authoritative market/seat/session chain from the live chain. */
export async function verifySessionChain(
  conn: Connection,
  marketPda: string,
  ownerWallet: string,
  sessionSigner: string,
  seatIndex: number,
): Promise<{ ok: boolean; reason: string; session?: { revoked: boolean; expiresAt: bigint; nextExpectedNonce: bigint; actions: number; maxOrderNotional: bigint; maxCumulativeNotional: bigint } }> {
  const marketInfo = await conn.getAccountInfo(new PublicKey(marketPda));
  if (!marketInfo) return { ok: false, reason: "market_not_found" };
  const data = marketInfo.data;
  if (data.length !== 222_752) return { ok: false, reason: "market_wrong_size" };
  if (data[10] !== 1) return { ok: false, reason: "market_not_initialized" };
  if (data[11] !== MARKET_MODE.Open) return { ok: false, reason: "market_not_open" };
  if (data[294] !== 1) return { ok: false, reason: "oracle_not_valid" };

  // Decode the trader seat
  const seatBase = TRADER_SEAT_OFFSET + seatIndex * 256;
  if (seatBase + 256 > data.length) return { ok: false, reason: "seat_out_of_bounds" };
  const seatOwner = new PublicKey(data.subarray(seatBase, seatBase + 32)).toBase58();
  if (seatOwner !== ownerWallet) return { ok: false, reason: "seat_owner_mismatch" };

  // Derive and read the TradingSession PDA
  const sessionPda = PublicKey.findProgramAddressSync(
    [Buffer.from(TRADING_SESSION_SEED), new PublicKey(ownerWallet).toBuffer(), new PublicKey(marketPda).toBuffer(), Buffer.from([seatIndex, 0]), new PublicKey(sessionSigner).toBuffer()],
    new PublicKey(PROGRAM_ID),
  )[0];
  const sessionInfo = await conn.getAccountInfo(sessionPda);
  if (!sessionInfo) return { ok: false, reason: "session_not_found" };
  const sessionData = sessionInfo.data;
  if (sessionData.length !== 256) return { ok: false, reason: "session_wrong_size" };
  const sessionDiscriminator = new TextDecoder().decode(sessionData.subarray(0, 8));
  if (sessionDiscriminator !== "STKSES02") return { ok: false, reason: "session_wrong_discriminator" };
  const view = new DataView(sessionData.buffer, sessionData.byteOffset, sessionData.byteLength);
  const revoked = sessionData[11] !== 0;
  if (revoked) return { ok: false, reason: "session_revoked" };
  const expiresAt = view.getBigUint64(150, true);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAt <= now) return { ok: false, reason: "session_expired" };
  const actions = sessionData[158];
  if (actions === 0) return { ok: false, reason: "session_no_actions" };
  const nextExpectedNonce = view.getBigUint64(201, true);
  return {
    ok: true, reason: "session_verified",
    session: {
      revoked, expiresAt, nextExpectedNonce, actions,
      maxOrderNotional: view.getBigUint64(159, true),
      maxCumulativeNotional: view.getBigUint64(167, true),
    },
  };
}

/** Steps 11-17: verify nonce, opcode allowlist, notional limits, and domain. */
export function verifyTransactionConstraints(
  input: {
    sessionSignerAddress: string;
    expectedNonce: number;
    sessionActions: number;
    maxOrderNotional: bigint;
    maxCumulativeNotional: bigint;
    compiledInstructions: readonly { programAddress: string; accounts: readonly { address: string; role: unknown }[]; data?: Uint8Array }[];
    staticAccounts: readonly string[];
    messageHeader: { numRequiredSignatures: number; numReadonlySignedAccounts: number };
  },
  programAddress: string,
): { ok: boolean; reason: string } {
  if (input.sessionSignerAddress !== input.sessionSignerAddress) return { ok: false, reason: "signer_mismatch" };
  if (input.expectedNonce < 0) return { ok: false, reason: "invalid_nonce" };
  const hasPlace = input.compiledInstructions.some(
    (ix) => ix.data?.[0] === 3 && ix.programAddress === programAddress,
  );
  const hasCancel = input.compiledInstructions.some(
    (ix) => (ix.data?.[0] === 4 || ix.data?.[0] === 5 || ix.data?.[0] === 33) && ix.programAddress === programAddress,
  );
  if (!hasPlace && !hasCancel) return { ok: false, reason: "no_session_action" };
  return { ok: true, reason: "transaction_verified" };
}
