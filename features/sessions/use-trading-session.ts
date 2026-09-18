"use client";

import { useCallback, useEffect, useState } from "react";
import { authorizeTradingSession, revokeTradingSession } from "@/clients/stockstream/src";
import { createSession, destroySession, hasSessionKey, lookupSession, type SessionStatus } from "@/lib/session-trading";
import type { TradingSessionView } from "@/clients/stockstream/src";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import { recordSignature } from "@/lib/last-signature";
import type { StockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";

function toSessionStatus(sessionPda: string, sessionSignerAddress: string, ownerWallet: string, marketPda: string, seatIndex: number, readback: TradingSessionView): SessionStatus {
  return {
    sessionPda,
    sessionSignerAddress,
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
  };
}

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
  const [rawStatus, setStatus] = useState<SessionStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A session belongs to whichever wallet authorized it -- switching the
  // active wallet must disable it immediately, not just until the next
  // render. This is a pure derivation (never shows a stale owner's
  // session for the new owner), not state kept in sync via an effect:
  // there is no render where the wrong owner's session is visible.
  const status = rawStatus && rawStatus.ownerWallet === ownerWallet ? rawStatus : null;

  // Actually destroying the in-memory key is a real side effect (clearing
  // a module-level Map), not a React state update, so it belongs in an
  // effect regardless -- "switching wallets clears the browser-local
  // session key" needs to actually happen, not just stop being displayed.
  // destroySession is idempotent, so re-running this while the mismatch
  // persists across renders is harmless.
  useEffect(() => {
    if (rawStatus && rawStatus.ownerWallet !== ownerWallet) destroySession(rawStatus.sessionSignerAddress);
  }, [ownerWallet, rawStatus]);

  const authorize = useCallback(async (config: SessionConfigInput) => {
    if (!protocol || !ownerWallet || !marketPda) { setError("Sign in and select a market before authorizing a session."); return; }
    setPending(true);
    setError(null);
    try {
      const created = await createSession(ownerWallet, marketPda, seatIndex);
      // The program compares expires_at against the MARKET's own clock
      // (header.last_verified_oracle_timestamp), not wall-clock -- see
      // handlers.rs::authorize_trading_session. Anchor to that, not
      // Date.now(), so "N minutes" means the same thing on-chain as it
      // does here even when the oracle is stale relative to wall-clock.
      const market = await protocol.rpc.market(marketPda);
      if (!market.state.oracleValid) {
        throw new Error("The market's oracle has never been verified -- session expiry has no valid clock reference yet.");
      }
      const expiresAt = Number(market.state.lastVerifiedOracleTimestamp) + config.expiresInMinutes * 60;
      const instruction = authorizeTradingSession(
        { market: marketPda, authority: ownerWallet, payer: ownerWallet, sessionSigner: created.sessionSignerAddress },
        expiresAt,
        { seatIndex, actions: config.actions, maxOrderNotional: config.maxOrderNotional, maxCumulativeNotional: config.maxCumulativeNotional, maximumExposure: config.maximumExposure, maximumOpenOrders: config.maximumOpenOrders },
      );
      const submitted = await protocol.service.executeL1(previewFor(instruction, "AuthorizeTradingSession"), [instruction]);
      recordSignature("AuthorizeTradingSession", submitted.signature, "l1");

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
      setStatus(toSessionStatus(created.sessionPda, created.sessionSignerAddress, ownerWallet, marketPda, seatIndex, readback));
    } catch (err) {
      setError(describeError(err, "AuthorizeTradingSession"));
    } finally {
      setPending(false);
    }
  }, [protocol, ownerWallet, marketPda, seatIndex]);

  // Rehydrates status from the on-chain session PDA on mount (e.g. after
  // navigating from Trade to Settings, or a page refresh) whenever a
  // browser-local session key for this owner/market/seat still exists in
  // memory. Without this, every page other than the one that called
  // authorize() would show "no session" for an already-authorized one.
  // Never rehydrates if the local key is gone: without it there is
  // nothing that can sign further trades regardless of on-chain state.
  useEffect(() => {
    if (!protocol || !ownerWallet || !marketPda || status) return;
    const existing = lookupSession(ownerWallet, marketPda, seatIndex);
    if (!existing || !hasSessionKey(existing.sessionSignerAddress)) return;
    let cancelled = false;
    protocol.rpc.tradingSession(existing.sessionPda).then((readback) => {
      if (cancelled || !readback) return;
      if (
        readback.sessionSigner.toBase58() !== existing.sessionSignerAddress ||
        readback.owner.toBase58() !== ownerWallet ||
        readback.market.toBase58() !== marketPda
      ) return;
      setStatus(toSessionStatus(existing.sessionPda, existing.sessionSignerAddress, ownerWallet, marketPda, seatIndex, readback));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [protocol, ownerWallet, marketPda, seatIndex, status]);

  const revoke = useCallback(async () => {
    if (!protocol || !ownerWallet || !marketPda || !status) { setError("No active session to revoke."); return; }
    setPending(true);
    setError(null);
    try {
      const instruction = revokeTradingSession({ market: marketPda, authority: ownerWallet, session: status.sessionPda, sessionSigner: status.sessionSignerAddress }, seatIndex);
      const submitted = await protocol.service.executeL1(previewFor(instruction, "RevokeTradingSession"), [instruction]);
      recordSignature("RevokeTradingSession", submitted.signature, "l1");
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

  // The program's nonce check is strict equality (session.rs::
  // validate_session_policy / handlers.rs::authorize_trading_actor:
  // `action_nonce != trading_session.next_expected_nonce` ->
  // SessionNonceReplay), so every consumed action MUST advance this by
  // exactly one locally, or the very next session-signed action would be
  // rejected on-chain as a replay. Only called after the relayer reports
  // an actual signature -- see lib/browser-session.ts::nextNonce's own
  // "never advance on a rejected action" contract.
  const advanceNonce = useCallback(() => {
    setStatus((current) => (current ? { ...current, nextExpectedNonce: current.nextExpectedNonce + 1n } : current));
  }, []);

  return { status, pending, error, authorize, revoke, clearLocal, advanceNonce };
}
