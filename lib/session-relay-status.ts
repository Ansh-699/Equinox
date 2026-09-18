/**
 * Explicit, typed session-trading UI states. A free-text notice string
 * alone can't be branched on reliably (wording drifts); this enum is what
 * the UI actually renders a distinct state for. Classification prefers
 * stable machine-readable signals (HTTP status, the small set of known
 * `error` codes both this app's proxy and the Worker relayer already
 * return) over pattern-matching the Worker's free-form validation
 * `reason` strings (session-relayer.ts), which are human-readable
 * diagnostics, not a stable API contract -- an unrecognized reason is
 * shown as "transaction_rejected" with the raw message kept available for
 * an expandable diagnostic area, never silently dropped.
 */
export type SessionBlockReason =
  | "authentication_required"
  | "session_invalid"
  | "session_expired"
  | "session_revoked"
  | "relayer_unconfigured"
  | "relayer_unavailable"
  | "fee_payer_unavailable"
  | "transaction_rejected";

export interface SessionActionResult {
  reason: SessionBlockReason | null;
  message: string;
  /** Raw backend detail, if any -- for an expandable diagnostic area, never the primary message. */
  detail?: string;
}

const REASON_LABEL: Record<SessionBlockReason, string> = {
  authentication_required: "Authentication required",
  session_invalid: "Session invalid",
  session_expired: "Session expired",
  session_revoked: "Session revoked",
  relayer_unconfigured: "Relayer configuration missing",
  relayer_unavailable: "Relayer unavailable",
  fee_payer_unavailable: "Fee payer unavailable",
  transaction_rejected: "Transaction rejected",
};

export function ok(message: string): SessionActionResult {
  return { reason: null, message };
}

export function blocked(reason: SessionBlockReason, detail?: string): SessionActionResult {
  return { reason, message: REASON_LABEL[reason], detail };
}

export interface RelaySuccessResult extends SessionActionResult { signature?: string }

/** Maps the proxy/relayer's raw HTTP response (lib/session-trading.ts's
 * RelayResponse) to a typed result. `error` codes recognized here are the
 * ones app/api/relay/session/route.ts and workers/src/index.ts's POST
 * /v1/relay/session are documented to return today; everything else is a
 * validation rejection from session-relayer.ts::validateSessionTransaction
 * and is bucketed as transaction_rejected with its message preserved as
 * detail rather than silently dropped. status 0 means the fetch itself
 * failed (offline, DNS, CORS) -- always relayer_unavailable, never
 * confused with a 5xx the server actually answered. */
export function classifyRelayResponse(response: { status: number; body: { signature?: string; error?: string; detail?: string } | null }): RelaySuccessResult {
  if (response.status === 0) return blocked("relayer_unavailable", "Network error reaching the relayer proxy");
  const error = response.body?.error;
  const detail = response.body?.detail ?? error;
  if (response.status === 401 || response.status === 403) return blocked("authentication_required", detail);
  if (error === "relayer_unconfigured") return blocked("relayer_unconfigured", detail);
  if (error === "relayer_signer_unconfigured") return blocked("fee_payer_unavailable", detail);
  if (response.status === 429) return blocked("relayer_unavailable", detail ?? "rate_limited");
  if (response.status >= 500) return blocked("relayer_unavailable", detail);
  if (response.status >= 400) return blocked("transaction_rejected", detail ?? "rejected");
  if (response.body?.signature) return { ...ok(`Relayed — signature ${response.body.signature.slice(0, 8)}…${response.body.signature.slice(-8)}`), signature: response.body.signature };
  return blocked("transaction_rejected", "relayer_response_invalid");
}
