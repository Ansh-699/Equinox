"use client";

import { useCallback, useState } from "react";
import { cancelAll, cancelAllV3, cancelOrder, cancelOrderV3, placeOrder, placeOrderV3, replaceOrder, replaceOrderV3, type PlaceOrderParams, type V3ExecutionAccounts } from "@/clients/equinox/src";
import { buildSessionSignedTransaction, isSessionUsable, submitToRelayer, toKitInstruction, type SessionStatus } from "@/lib/session-trading";
import { actionAllowed } from "@/lib/browser-session";
import { readCsrfToken } from "@/lib/csrf";
import { blocked, classifyRelayResponse, type SessionActionResult } from "@/lib/session-relay-status";
import { recordSignature } from "@/lib/last-signature";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";
import type { AppAuth } from "@/components/app-providers";
import type { ExecutionDisplayState } from "@/lib/execution-status";

const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_EQUINOX_RELAYER_ADDRESS;

type SessionAction = "place" | "cancel" | "cancelAll" | "replace" | "reduceOnlyClose";

function requiredActionBits(action: SessionAction, reduceOnly: boolean): readonly SessionAction[] {
  // handlers.rs::place_order (and replace_order) require BOTH bits for a
  // reduce-only order: `required_actions = if reduce_only { PLACE |
  // REDUCE_ONLY_CLOSE } else { PLACE }` -- reduceOnlyClose alone is never
  // sufficient to open (or replace into) a reduce-only order.
  if ((action === "place" || action === "replace") && reduceOnly) return [action, "reduceOnlyClose"];
  return [action];
}

export type SessionActionGate =
  | { allowed: true; domain: "l1" | "er" }
  | { allowed: false; result: SessionActionResult };

export type SessionExecutionMode =
  | { mode: "v3"; accounts: V3ExecutionAccounts }
  | { mode: "v2" }
  | { mode: "invalid"; reason: string };

/** Resolve the write ABI explicitly. V2 is retained only for deployments
 * that have no configured V3 core; a configured V3 deployment must never
 * silently downgrade a malformed/missing session bundle to V2. */
export function resolveSessionExecutionMode(
  session: Pick<SessionStatus, "v3ExecutionAccounts">,
  configuredV3Core: string | undefined = process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS,
): SessionExecutionMode {
  const accounts = session.v3ExecutionAccounts as V3ExecutionAccounts | undefined;
  if (configuredV3Core && !accounts) {
    return { mode: "invalid", reason: "V3 execution bundle unavailable for the configured V3 core" };
  }
  return accounts ? { mode: "v3", accounts } : { mode: "v2" };
}

/** Pure, unit-testable prefix of relay(): every reason a session-signed
 * action must be refused before a transaction is even built, in the order
 * they're checked. Kept separate from the relay/submit side effects so
 * every combination is directly testable without mocking RPC/relayer
 * network calls. */
export function evaluateSessionActionGate(
  session: SessionStatus | null,
  actions: readonly SessionAction[],
  executionStatus: ExecutionDisplayState | null,
): SessionActionGate {
  if (!session) return { allowed: false, result: blocked("session_invalid", "No authorized session") };
  if (session.revoked) return { allowed: false, result: blocked("session_revoked") };
  if (!isSessionUsable(session)) return { allowed: false, result: blocked("session_expired") };
  for (const action of actions) {
    if (!actionAllowed(session.actions, action)) return { allowed: false, result: blocked("session_invalid", `Session is not authorized for ${action}`) };
  }
  if (!executionStatus) return { allowed: false, result: blocked("execution_status_unavailable", "MagicBlock execution-status endpoint has not returned a status") };
  const domain = executionStatus.orderRoutingDomain;
  if (!domain) return { allowed: false, result: blocked("er_transition_blocked", "The market is currently transitioning between L1 and the ER -- try again once it settles") };
  return { allowed: true, domain };
}

/** Session-signed order actions relayed through app/api/relay/session.
 * Every path re-checks session usability and the specific action bit(s)
 * client-side (the on-chain program is still the real authority) before
 * ever asking the session key to sign anything, and every result is
 * classified into the explicit UI states in lib/session-relay-status.ts --
 * never a bare "it worked"/"it didn't" string. Every action is also gated
 * on the authoritative MagicBlock execution status
 * (lib/execution-status.ts's orderRoutingDomain): a market mid-transition
 * between L1 and the ER, or whose status can't be read at all, refuses to
 * route rather than guessing which domain currently owns the account. */
export function useSessionOrder(
  rpc: SolanaRpcTransport | null,
  session: SessionStatus | null,
  auth: Pick<AppAuth, "walletAddress" | "getAccessToken">,
  onResult: (result: SessionActionResult) => void,
  advanceNonce: () => void,
  executionStatus: ExecutionDisplayState | null,
) {
  const [pending, setPending] = useState(false);

  const relay = useCallback(async (instruction: ReturnType<typeof placeOrder> | ReturnType<typeof placeOrderV3>, actions: readonly SessionAction[], label: string) => {
    const gate = evaluateSessionActionGate(session, actions, executionStatus);
    if (!gate.allowed) return onResult(gate.result);
    const { domain } = gate;
    if (!RELAYER_ADDRESS) return onResult(blocked("relayer_unconfigured", "NEXT_PUBLIC_EQUINOX_RELAYER_ADDRESS is unset"));
    if (!rpc) return onResult(blocked("relayer_unavailable", "No RPC transport for a fresh blockhash"));
    if (!auth.walletAddress) return onResult(blocked("authentication_required", "No active wallet"));
    if (!session) return onResult(blocked("session_invalid", "No authorized session")); // narrows for TS; gate.allowed already guarantees this
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
        domain,
      });
      // HTTP acceptance alone is never success: classifyRelayResponse only
      // reports `reason: null` when the body actually carried a signature.
      const classified = classifyRelayResponse(response);
      if (classified.signature) {
        recordSignature(label, classified.signature, domain);
        // Must advance on success ONLY: the program's nonce check is exact
        // equality, so an un-advanced nonce would make the very next
        // session-signed action replay this one's nonce and be rejected.
        advanceNonce();
      }
      onResult(classified);
    } catch (err) {
      onResult(blocked("transaction_rejected", err instanceof Error ? err.message : String(err)));
    } finally {
      setPending(false);
    }
  }, [session, rpc, auth, onResult, advanceNonce, executionStatus]);

  const placeSessionOrder = useCallback((params: Omit<PlaceOrderParams, "authority" | "session" | "actionNonce" | "market" | "seatIndex">) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const execution = resolveSessionExecutionMode(session);
    if (execution.mode === "invalid") { onResult(blocked("session_invalid", execution.reason)); return Promise.resolve(); }
    const v3 = execution.mode === "v3" ? execution.accounts : undefined;
    const instruction = v3
      ? placeOrderV3({ ...params, ...v3, core: v3.core, seatIndex: session.seatIndex, authority: session.sessionSignerAddress, session: session.sessionPda, actionNonce: session.nextExpectedNonce })
      : placeOrder({ ...params, market: session.marketPda, seatIndex: session.seatIndex, authority: session.sessionSignerAddress, session: session.sessionPda, actionNonce: session.nextExpectedNonce });
    return relay(instruction, requiredActionBits("place", params.reduceOnly ?? false), params.reduceOnly ? "ReduceOnlyClose" : "PlaceOrder");
  }, [relay, session, onResult]);

  const cancelSessionOrder = useCallback((orderKey: bigint) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const execution = resolveSessionExecutionMode(session);
    if (execution.mode === "invalid") { onResult(blocked("session_invalid", execution.reason)); return Promise.resolve(); }
    const v3 = execution.mode === "v3" ? execution.accounts : undefined;
    const instruction = v3
      ? cancelOrderV3({ ...v3, core: v3.core, authority: session.sessionSignerAddress, session: session.sessionPda }, session.seatIndex, orderKey, session.nextExpectedNonce)
      : cancelOrder({ market: session.marketPda, authority: session.sessionSignerAddress, session: session.sessionPda }, session.seatIndex, orderKey, session.nextExpectedNonce);
    return relay(instruction, ["cancel"], "CancelOrder");
  }, [relay, session, onResult]);

  const replaceSessionOrder = useCallback((oldOrderKey: bigint, params: Omit<PlaceOrderParams, "authority" | "session" | "actionNonce" | "market" | "seatIndex">) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const execution = resolveSessionExecutionMode(session);
    if (execution.mode === "invalid") { onResult(blocked("session_invalid", execution.reason)); return Promise.resolve(); }
    const v3 = execution.mode === "v3" ? execution.accounts : undefined;
    const instruction = v3
      ? replaceOrderV3({ ...params, ...v3, core: v3.core, oldOrderKey, seatIndex: session.seatIndex, authority: session.sessionSignerAddress, session: session.sessionPda, actionNonce: session.nextExpectedNonce })
      : replaceOrder({ ...params, oldOrderKey, market: session.marketPda, seatIndex: session.seatIndex, authority: session.sessionSignerAddress, session: session.sessionPda, actionNonce: session.nextExpectedNonce });
    return relay(instruction, requiredActionBits("replace", params.reduceOnly ?? false), "ReplaceOrder");
  }, [relay, session, onResult]);

  const cancelAllSessionOrders = useCallback((limit: number) => {
    if (!session) { onResult(blocked("session_invalid")); return Promise.resolve(); }
    const execution = resolveSessionExecutionMode(session);
    if (execution.mode === "invalid") { onResult(blocked("session_invalid", execution.reason)); return Promise.resolve(); }
    const v3 = execution.mode === "v3" ? execution.accounts : undefined;
    const instruction = v3
      ? cancelAllV3({ ...v3, core: v3.core, authority: session.sessionSignerAddress, session: session.sessionPda }, session.seatIndex, limit, session.nextExpectedNonce)
      : cancelAll({ market: session.marketPda, authority: session.sessionSignerAddress, session: session.sessionPda }, session.seatIndex, limit, session.nextExpectedNonce);
    return relay(instruction, ["cancelAll"], "CancelAll");
  }, [relay, session, onResult]);

  return { pending, placeSessionOrder, cancelSessionOrder, replaceSessionOrder, cancelAllSessionOrders };
}
