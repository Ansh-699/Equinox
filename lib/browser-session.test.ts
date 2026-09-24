import { expect, test } from "vitest";
import {
  actionAllowed,
  clearAllSessionKeys,
  clearSessionKey,
  generateSessionKey,
  hasSessionKey,
  isSessionUsable,
  nextNonce,
  signWithSessionKey,
  SESSION_ACTION,
  type SessionStatus,
} from "./browser-session";

test("session key generates a valid Solana address and stays memory-only", async () => {
  const key = await generateSessionKey();
  // Base58-encoded 32-byte Ed25519 public keys are 32-44 chars depending on
  // leading zero bytes -- a fixed toHaveLength(44) is flaky, not a real check.
  expect(key.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  expect(key.keyId).toMatch(/^session:/);
  expect(hasSessionKey(key.address)).toBe(true);
  expect(JSON.stringify(key)).not.toMatch(/privateKey|seed/);
  clearAllSessionKeys();
  expect(hasSessionKey(key.address)).toBe(false);
});

test("signs with the stored key and verifies against the public key", async () => {
  const key = await generateSessionKey();
  const message = new TextEncoder().encode("equinox session action");
  const signature = await signWithSessionKey(key.address, message);
  expect(signature).toHaveLength(64);
  const { getBase58Encoder: encoder } = await import("@solana/kit");
  const publicBytes = (encoder() as unknown as { encode(value: string): Uint8Array }).encode(key.address);
  const keyPair = await crypto.subtle.importKey("raw", publicBytes.buffer.slice(publicBytes.byteOffset, publicBytes.byteOffset + publicBytes.length), { name: "Ed25519" }, true, ["verify"]);
  expect(await crypto.subtle.verify("Ed25519", keyPair, signature.slice().buffer, message.slice().buffer)).toBe(true);
});

test("clearing the key destroys signing ability permanently", async () => {
  const key = await generateSessionKey();
  clearSessionKey(key.address);
  expect(hasSessionKey(key.address)).toBe(false);
  await expect(signWithSessionKey(key.address, new Uint8Array(4))).rejects.toThrow(/no session key in memory/);
});

test("session usability: expiry and revocation gate; actions gate", () => {
  const base: SessionStatus = {
    sessionPda: "SessionPda1111111111111111111111111111111111",
    sessionSignerAddress: "Signer1111111111111111111111111111111111111",
    ownerWallet: "Owner11111111111111111111111111111111111111",
    marketPda: "Market1111111111111111111111111111111111111",
    seatIndex: 0,
    actions: 0b1011,
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    maxOrderNotional: "1000",
    maxCumulativeNotional: "10000",
    maximumExposure: "1000",
    maximumOpenOrders: 32,
    nextExpectedNonce: 1n,
    revoked: false,
  };
  expect(isSessionUsable(base)).toBe(true);
  expect(isSessionUsable({ ...base, revoked: true })).toBe(false);
  expect(isSessionUsable({ ...base, expiresAt: Math.floor(Date.now() / 1000) - 1 })).toBe(false);
  expect(isSessionUsable({ ...base, actions: 0 })).toBe(false);
});

test("allowlist checks match the program's bit layout", () => {
  expect(actionAllowed(0b1011, "place")).toBe(true);
  expect(actionAllowed(0b1011, "cancelAll")).toBe(false);
  expect(actionAllowed(0b10000, "reduceOnlyClose")).toBe(true);
  expect(actionAllowed(0, "place")).toBe(false);
});

test("nonce progression only advances on confirmed consumption", () => {
  const status: SessionStatus = {
    ...({} as SessionStatus),
    nextExpectedNonce: 5n,
  } as SessionStatus;
  expect(nextNonce(status, false)).toBe(5n);
  expect(nextNonce(status, true)).toBe(6n);
});
