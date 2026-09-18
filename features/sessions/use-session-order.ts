"use client";

import { useCallback, useState } from "react";
import { cancelAll, cancelOrder, placeOrder, replaceOrder, type PlaceOrderParams } from "@/clients/stockstream/src";
import { buildSessionSignedTransaction, isSessionUsable, submitToRelayer, toKitInstruction, type SessionStatus } from "@/lib/session-trading";
import { actionAllowed } from "@/lib/browser-session";
import { readCsrfToken } from "@/lib/csrf";
import { blocked, classifyRelayResponse, type SessionActionResult } from "@/lib/session-relay-status";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";
import type { AppAuth } from "@/components/app-providers";

const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS;

type SessionAction = "place" | "cancel" | "cancelAll" | "replace" | "reduceOnlyClose";

function requiredActionBits(action: SessionAction, reduceOnly: boolean): readonly SessionAction[] {
  // handlers.rs::place_order (and replace_order) require BOTH bits for a
  // reduce-only order: `required_actions = if reduce_only { PLACE |
  // REDUCE_ONLY_CLOSE } else { PLACE }` -- reduceOnlyClose alone is never
  // sufficient to open (or replace into) a reduce-only order.
  if ((action === "place" || action === "replace") && reduceOnly) return [action, "reduceOnlyClose"];
  return [action];
}

/** Session-signed order actions relayed through app/api/relay/session.
 * Every path re-checks session usability and the specific action bit(s)
 * client-side (the on-chain program is still the real authority) before
 * ever asking the session key to sign anything, and every result is
 * classified into the explicit UI states in lib/session-relay-status.ts --
 * never a bare "it worked"/"it didn't" string. ER routing is deliberately
 * not implemented here yet: sending an order to a market that isn't
 * delegated would be an incompatible-domain transaction the spec requires
 * us to refuse, and delegation-status checking doesn't exist in this
 * codebase yet either. */
export function useSessionOrder(
  rpc: SolanaRpcTransport | null,
  session: SessionStatus | null,
  auth: Pick<AppAuth, "walletAddress" | "getAccessToken">,
  onResult: (result: SessionActionResult) => void,
) {
  const [pending, setPending] = useState(false);

  const relay = useCallback(async (instruction: ReturnType<typeof placeOrder>, actions: readonly SessionAction[], label: string) => {
    if (!session) return onResult(blocked("session_invalid", "No authorized session"));
    if (session.revoked) return onResult(blocked("session_revoked"));
    if (!isSessionUsable(session)) return onResult(blocked("session_expired"));
    for (const action of actions) {
      if (!actionAllowed(session.actions, action)) return onResult(blocked("session_invalid", `Session is not authorized for ${action}`));
    }
    if (!RELAYER_ADDRESS) return onResult(blocked("relayer_unconfigured", "NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS is unset"));
    if (!rpc) return onResult(blocked("relayer_unavailable", "No RPC transport for a fresh blockhash"));
    if (!auth.walletAddress) return onResult(blocked("authentication_required", "No active wallet"));
    const privyAccessToken = await auth.getAccessToken();
    if (!privyAccessToken) return onResult(blocked("authentication_required", "No Privy access token"));
    const csrfToken = readCsrfToken();
    if (!csrfToken) return onResult(blocked("authentication_required", "No app session token"));

    setPending(true);
    onResult({ reason: null, message: `Submitting ${label}…` });
    try {
      const { blockhash } = await rpc.latestBlockhash();
      const { base64 } = await buildSessionSignedTransaction({
        sessionSignerAddress: session.sessionSignerAddress,
        relayerAddress: RELAYER_ADDRESS,
        instructions: [toKitInstruction(instruction)],
        recentBlockhash: blockhash,
      });
      const response = await submitToRelayer({
        csrfToken,
        privyAccessToken,
        ownerWallet: auth.walletAddress,
        transactionBase64: base64,
        expectedProgramAddress: instruction.programId.toBase58(),
        expectedMarket: session.marketPda,
        expectedNonce: session.nextExpectedNonce,
        sessionSignerAddress: session.sessionSignerAddress,
        clientRequestId: crypto.randomUUID(),
        domain: "l1",
      });
      // HTTP acceptance alone is never success: classifyRelayResponse only
      // reports `reason: null` when the body actually carried a signature.
      onResult(classifyRelayResponse(response));
    } catch (err) {
      onResult(blocked("transaction_rejected", err instanceof Error ? err.message : String(err)));
    } finally {
      setPending(false);
    }
  }, [session, rpc, auth, onResult]);

  const placeSessionOrder = useCallback((params: Omit<PlaceOrderParams, "authority" | "session" | "actionNonce" | "market" | "seatIndex">) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const instruction = placeOrder({
      ...params,
      market: session.marketPda,
      seatIndex: session.seatIndex,
      authority: session.sessionSignerAddress,
      session: session.sessionPda,
      actionNonce: session.nextExpectedNonce,
    });
    return relay(instruction, requiredActionBits("place", params.reduceOnly ?? false), params.reduceOnly ? "ReduceOnlyClose" : "PlaceOrder");
  }, [relay, session, onResult]);

  const cancelSessionOrder = useCallback((orderKey: bigint) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const instruction = cancelOrder(
      { market: session.marketPda, authority: session.sessionSignerAddress, session: session.sessionPda },
      session.seatIndex,
      orderKey,
      session.nextExpectedNonce,
    );
    return relay(instruction, ["cancel"], "CancelOrder");
  }, [relay, session, onResult]);

  const replaceSessionOrder = useCallback((oldOrderKey: bigint, params: Omit<PlaceOrderParams, "authority" | "session" | "actionNonce" | "market" | "seatIndex">) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const instruction = replaceOrder({
      ...params,
      oldOrderKey,
      market: session.marketPda,
      seatIndex: session.seatIndex,
      authority: session.sessionSignerAddress,
      session: session.sessionPda,
      actionNonce: session.nextExpectedNonce,
    });
    return relay(instruction, requiredActionBits("replace", params.reduceOnly ?? false), "ReplaceOrder");
  }, [relay, session, onResult]);

  const cancelAllSessionOrders = useCallback((limit: number) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const instruction = cancelAll(
      { market: session.marketPda, authority: session.sessionSignerAddress, session: session.sessionPda },
      session.seatIndex,
      limit,
      session.nextExpectedNonce,
    );
    return relay(instruction, ["cancelAll"], "CancelAll");
  }, [relay, session, onResult]);

  return { pending, placeSessionOrder, cancelSessionOrder, replaceSessionOrder, cancelAllSessionOrders };
}
