import { describe, expect, it } from "vitest";
import { classifyRelayResponse } from "./session-relay-status";

describe("classifyRelayResponse", () => {
  it("status 0 (fetch itself failed) is always relayer_unavailable, never confused with a 5xx", () => {
    expect(classifyRelayResponse({ status: 0, body: null }).reason).toBe("relayer_unavailable");
  });
  it("401/403 map to authentication_required", () => {
    expect(classifyRelayResponse({ status: 401, body: { error: "authentication_required" } }).reason).toBe("authentication_required");
    expect(classifyRelayResponse({ status: 403, body: { error: "authentication_required", detail: "CSRF validation failed" } }).reason).toBe("authentication_required");
  });
  it("relayer_unconfigured error code maps regardless of status", () => {
    expect(classifyRelayResponse({ status: 503, body: { error: "relayer_unconfigured" } }).reason).toBe("relayer_unconfigured");
  });
  it("relayer_signer_unconfigured maps to fee_payer_unavailable, distinct from relayer_unconfigured", () => {
    expect(classifyRelayResponse({ status: 503, body: { error: "relayer_signer_unconfigured" } }).reason).toBe("fee_payer_unavailable");
  });
  it("429 maps to relayer_unavailable (rate limited, not a rejection of this specific transaction)", () => {
    expect(classifyRelayResponse({ status: 429, body: { error: "rate_limited" } }).reason).toBe("relayer_unavailable");
  });
  it("any other 5xx is relayer_unavailable", () => {
    expect(classifyRelayResponse({ status: 502, body: null }).reason).toBe("relayer_unavailable");
  });
  it("an unrecognized 400-family error is bucketed as transaction_rejected with the raw reason preserved as detail", () => {
    const result = classifyRelayResponse({ status: 400, body: { error: "opcode 99 is not allowed for a session-signed transaction" } });
    expect(result.reason).toBe("transaction_rejected");
    expect(result.detail).toContain("opcode 99");
  });
  it("a 2xx with a signature is success and carries the signature through, never treated as a rejection", () => {
    const result = classifyRelayResponse({ status: 202, body: { signature: "5".repeat(64) } });
    expect(result.reason).toBeNull();
    expect(result.signature).toBe("5".repeat(64));
  });
  it("a 2xx with no signature is NOT treated as success -- HTTP acceptance alone is never enough", () => {
    const result = classifyRelayResponse({ status: 202, body: null });
    expect(result.reason).toBe("transaction_rejected");
    expect(result.signature).toBeUndefined();
  });
});
