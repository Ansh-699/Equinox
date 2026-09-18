"use client";

import { useCallback, useState } from "react";
import { cancelAll, placeOrder, type PlaceOrderParams } from "@/clients/stockstream/src";
import { buildSessionSignedTransaction, isSessionUsable, submitToRelayer, toKitInstruction, type SessionStatus } from "@/lib/session-trading";
import { actionAllowed } from "@/lib/browser-session";
import { readCsrfToken } from "@/lib/csrf";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS;

type SessionAction = "place" | "cancel" | "cancelAll" | "replace" | "reduceOnlyClose";

/** Session-signed order actions relayed through app/api/relay/session.
 * Every path re-checks session usability and the specific action bit
 * client-side (the on-chain program is still the real authority) before
 * ever asking the session key to sign anything. ER routing is deliberately
 * not implemented here yet: sending an order to a market that isn't
 * delegated would be an incompatible-domain transaction the spec requires
 * us to refuse, and delegation-status checking doesn't exist in this
 * codebase yet either. */
export function useSessionOrder(rpc: SolanaRpcTransport | null, session: SessionStatus | null, notify: (message: string) => void) {
  const [pending, setPending] = useState(false);

  const relay = useCallback(async (instruction: ReturnType<typeof placeOrder>, action: SessionAction, label: string) => {
    if (!session) { notify("Authorize a trading session first."); return; }
    if (!isSessionUsable(session)) { notify("Session is expired, revoked, or has no allowed actions."); return; }
    if (!actionAllowed(session.actions, action)) { notify(`Session is not authorized for ${label}.`); return; }
    if (!RELAYER_ADDRESS) { notify("Session trading is blocked: the relayer has not published its fee-payer address yet (NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS unset)."); return; }
    if (!rpc) { notify("No RPC transport available for a fresh blockhash."); return; }
    setPending(true);
    notify(`Submitting ${label}…`);
    try {
      const { blockhash } = await rpc.latestBlockhash();
      const { base64 } = await buildSessionSignedTransaction({
        sessionSignerAddress: session.sessionSignerAddress,
        relayerAddress: RELAYER_ADDRESS,
        instructions: [toKitInstruction(instruction)],
        recentBlockhash: blockhash,
      });
      const csrfToken = readCsrfToken();
      if (!csrfToken) { notify("Missing app session token -- sign in again."); return; }
      const result = await submitToRelayer({
        csrfToken,
        transactionBase64: base64,
        expectedProgramAddress: instruction.programId.toBase58(),
        sessionSignerAddress: session.sessionSignerAddress,
        domain: "l1",
      });
      notify("error" in result ? `${label} rejected by relayer: ${result.error}` : `${label} relayed — signature ${result.signature.slice(0, 8)}…${result.signature.slice(-8)}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setPending(false);
    }
  }, [session, rpc, notify]);

  const placeSessionOrder = useCallback((params: Omit<PlaceOrderParams, "authority" | "session" | "actionNonce" | "market" | "seatIndex">) => {
    if (!session) { notify("Authorize a trading session first."); return Promise.resolve(); }
    const instruction = placeOrder({
      ...params,
      market: session.marketPda,
      seatIndex: session.seatIndex,
      authority: session.sessionSignerAddress,
      session: session.sessionPda,
      actionNonce: session.nextExpectedNonce,
    });
    return relay(instruction, "place", "PlaceOrder");
  }, [relay, session, notify]);

  const cancelAllSessionOrders = useCallback((limit: number) => {
    if (!session) { notify("Authorize a trading session first."); return Promise.resolve(); }
    const instruction = cancelAll(
      { market: session.marketPda, authority: session.sessionSignerAddress, session: session.sessionPda },
      session.seatIndex,
      limit,
      session.nextExpectedNonce,
    );
    return relay(instruction, "cancelAll", "CancelAll");
  }, [relay, session, notify]);

  return { pending, placeSessionOrder, cancelAllSessionOrders };
}
