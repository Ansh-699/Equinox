"use client";

import { useCallback, useState } from "react";
import { authorizeTradingSession, revokeTradingSession } from "@/clients/stockstream/src";
import { createSession, destroySession, type SessionStatus } from "@/lib/session-trading";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import type { StockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";

export interface SessionConfigInput {
  expiresInMinutes: number;
  maxOrderNotional: bigint;
  maxCumulativeNotional: bigint;
  maximumExposure: bigint;
  maximumOpenOrders: number;
  actions: number;
}

function previewFor(instruction: { programId: { toBase58(): string }; keys: readonly { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[] }, name: string): TransactionPreview {
  return {
    instruction: name,
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
    status: "constructed",
  };
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof RpcFailure) return `${fallback} failed at ${error.method} (${error.code}).`;
  if (error instanceof Error) return error.message;
  return fallback;
}

/** Owns the one-main-wallet-prompt session lifecycle: authorize (with
 * authoritative on-chain readback before trading is ever enabled) and
 * revoke (which also destroys the in-memory session key immediately). */
export function useTradingSession(protocol: StockStreamProtocol | null, ownerWallet: string | null, marketPda: string | null, seatIndex = 0) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authorize = useCallback(async (config: SessionConfigInput) => {
    if (!protocol || !ownerWallet || !marketPda) { setError("Sign in and select a market before authorizing a session."); return; }
    setPending(true);
    setError(null);
    try {
      const created = await createSession(ownerWallet, marketPda, seatIndex);
      const expiresAtMs = Date.now() + config.expiresInMinutes * 60_000;
      const instruction = authorizeTradingSession(
        { market: marketPda, authority: ownerWallet, payer: ownerWallet, sessionSigner: created.sessionSignerAddress },
        expiresAtMs,
        { seatIndex, actions: config.actions, maxOrderNotional: config.maxOrderNotional, maxCumulativeNotional: config.maxCumulativeNotional, maximumExposure: config.maximumExposure, maximumOpenOrders: config.maximumOpenOrders },
      );
      await protocol.service.executeL1(previewFor(instruction, "AuthorizeTradingSession"), [instruction]);

      // Never enable session trading on the strength of a submitted/confirmed
      // signature alone: read the PDA back and verify every field a stale or
      // mismatched session would get wrong.
      const readback = await protocol.rpc.tradingSession(created.sessionPda);
      if (
        !readback ||
        readback.revoked ||
        readback.sessionSigner.toBase58() !== created.sessionSignerAddress ||
        readback.owner.toBase58() !== ownerWallet ||
        readback.market.toBase58() !== marketPda
      ) {
        throw new Error("Session authorized on-chain but readback did not match the requested session -- trading stays disabled.");
      }
      setStatus({
        sessionPda: created.sessionPda,
        sessionSignerAddress: created.sessionSignerAddress,
        ownerWallet,
        marketPda,
        seatIndex,
        actions: readback.actions,
        expiresAt: Number(readback.expiresAt),
        maxOrderNotional: readback.maxOrderNotional.toString(),
        maxCumulativeNotional: readback.maxCumulativeNotional.toString(),
        maximumExposure: readback.maxExposure.toString(),
        maximumOpenOrders: readback.maxOpenOrders,
        nextExpectedNonce: readback.nextExpectedNonce,
        revoked: readback.revoked,
      });
    } catch (err) {
      setError(describeError(err, "AuthorizeTradingSession"));
    } finally {
      setPending(false);
    }
  }, [protocol, ownerWallet, marketPda, seatIndex]);

  const revoke = useCallback(async () => {
    if (!protocol || !ownerWallet || !marketPda || !status) { setError("No active session to revoke."); return; }
    setPending(true);
    setError(null);
    try {
      const instruction = revokeTradingSession({ market: marketPda, authority: ownerWallet, session: status.sessionPda, sessionSigner: status.sessionSignerAddress }, seatIndex);
      await protocol.service.executeL1(previewFor(instruction, "RevokeTradingSession"), [instruction]);
      // Clear the in-memory key immediately -- do not wait on a subsequent
      // readback poll; a revoked key must stop being usable right away.
      destroySession(status.sessionSignerAddress);
      setStatus(null);
    } catch (err) {
      setError(describeError(err, "RevokeTradingSession"));
    } finally {
      setPending(false);
    }
  }, [protocol, ownerWallet, marketPda, status, seatIndex]);

  const clearLocal = useCallback(() => {
    if (status) destroySession(status.sessionSignerAddress);
    setStatus(null);
  }, [status]);

  return { status, pending, error, authorize, revoke, clearLocal };
}
