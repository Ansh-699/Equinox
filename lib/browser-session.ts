"use client";

/**
 * Browser-local Ed25519 trading-session key management.
 *
 * Threat model (documented, not incidental):
 * - The session private key is generated IN THE BROWSER with WebCrypto and
 *   lives ONLY in this module's in-memory closure. It is never sent to the
 *   backend, never stored in D1/KV, logs, analytics, URLs, or cookies, and
 *   never written to localStorage/sessionStorage/IndexedDB. Clearing it
 *   (logout, revocation, expiry, page unload choice) destroys the key
 *   permanently -- a persisted session requires a new authorization
 *   transaction from the main wallet, which is the intended safety
 *   property: a stolen browser session cannot re-authorize silently.
 * - Authorization (on-chain scope, limits, expiry) is granted ONCE by the
 *   main wallet (`authorizeTradingSession`, `handlers.rs::
 *   authorize_trading_actor`); every subsequent trade is signed by this
 *   session key and relayed with the Worker's fee-payer co-signature.
 *   On-chain, the program independently enforces the nonce/action/
 *   notional/exposure policy (`session.rs`), so a compromised relayer can
 *   neither widen the session nor move collateral: deposits and
 *   withdrawals have no session-signed form at all.
 */

export interface SessionKeyPair {
  /** Base58 Solana address (public key), safe to display/submit. */
  address: string;
  /** Opaque handle for logging -- a prefix, never the key. */
  keyId: string;
}

/** Generates a new browser-local session key. The private seed is retained
 * only inside this module; nothing here can export it after creation. */
export async function generateSessionKey(): Promise<SessionKeyPair> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
  const rawPublic = new Uint8Array((await crypto.subtle.exportKey("raw", await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, true, ["verify"]))) as ArrayBuffer);
  const seed = base64UrlDecode(jwk.d!);
  const { getBase58Encoder, getBase58Decoder } = await import("@solana/kit");
  const address = getBase58Decoder().decode(rawPublic);
  void seed; // retained only in the signer below
  registerKey(address, seed);
  void getBase58Encoder;
  return { address, keyId: `session:${address.slice(0, 6)}…` };
}

// The ONLY private-key storage in the entire browser app: a module-scoped
// Map from address -> seed, never serialized anywhere.
const seeds = new Map<string, Uint8Array>();

function registerKey(address: string, seed: Uint8Array): void {
  seeds.set(address, seed);
}

/** True while this browser holds live session-key material in memory. */
export function hasSessionKey(address: string): boolean {
  return seeds.has(address);
}

/** Destroys the in-memory key. Called on logout, revocation, expiry, and
 * (by explicit user action) page reload. Idempotent. */
export function clearSessionKey(address: string): void {
  const seed = seeds.get(address);
  if (seed) seed.fill(0);
  seeds.delete(address);
}

export function clearAllSessionKeys(): void {
  for (const address of [...seeds.keys()]) clearSessionKey(address);
}

/** Signs raw message bytes with the stored session key. Throws (never
 * fabricates) if the key is absent from memory. */
export async function signWithSessionKey(address: string, message: Uint8Array): Promise<Uint8Array> {
  const seed = seeds.get(address);
  if (!seed) throw new Error("no session key in memory for this address");
  const pkcs8 = pkcs8Wrap(seed);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key, message));
}

function pkcs8Wrap(seed: Uint8Array): ArrayBuffer {
  const prefix = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const out = new Uint8Array(prefix.length + seed.length);
  out.set(prefix, 0);
  out.set(seed, prefix.length);
  return out.buffer;
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------
// Session lifecycle state (pure, serializable, backend-mirrorable).
// ---------------------------------------------------------------------

export const SESSION_ACTION = {
  place: 1 << 0,
  cancel: 1 << 1,
  cancelAll: 1 << 2,
  replace: 1 << 3,
  reduceOnlyClose: 1 << 4,
  all: (1 << 5) - 1,
} as const;

export interface SessionPolicy {
  seatIndex: number;
  actions: number;
  maxOrderNotional: bigint;
  maxCumulativeNotional: bigint;
  maximumExposure: bigint;
  maximumOpenOrders: number;
}

export interface SessionStatus {
  /** The authorized session PDA (base58), as the program derives it. */
  sessionPda: string;
  sessionSignerAddress: string;
  ownerWallet: string;
  marketPda: string;
  seatIndex: number;
  actions: number;
  /** Unix SECONDS, matching `TradingSession.expires_at` on-chain
   * (programs/equinox/src::session.rs). The program compares this
   * against `header.last_verified_oracle_timestamp` -- the market's own
   * clock, anchored to the oracle, not `Clock::get()` and not
   * milliseconds (see handlers.rs::authorize_trading_session /
   * authorize_trading_actor). A millisecond value here would make a
   * session appear valid roughly 1000x longer than intended. */
  expiresAt: number;
  maxOrderNotional: string;
  maxCumulativeNotional: string;
  maximumExposure: string;
  maximumOpenOrders: number;
  /** The next action nonce the client must submit (program-enforced). */
  nextExpectedNonce: bigint;
  /** Set once a revoke is observed on-chain. */
  revoked: boolean;
  /** Present only after a V3 session readback. Its addresses are the
   * canonical core/page/seat/event/session bundle used by V3 writes. */
  v3ExecutionAccounts?: {
    core: string;
    bookPages: readonly string[];
    seatShards: readonly string[];
    eventShards: readonly string[];
    authority: string;
    session?: string;
  };
}

/** `nowUnixSeconds` is a client-side estimate (wall-clock) for display
 * purposes only -- the program's real "now" is the market's last verified
 * oracle timestamp, which this client does not always have fresh. This
 * function never gates an actual submission's validity; the on-chain
 * program does that regardless of what this returns. */
export function isSessionUsable(status: SessionStatus, nowUnixSeconds = Math.floor(Date.now() / 1000)): boolean {
  return !status.revoked && Number(status.expiresAt) > nowUnixSeconds && status.actions !== 0;
}

export function actionAllowed(actions: number, action: keyof typeof SESSION_ACTION): boolean {
  if (action === "all") return false;
  return (actions & SESSION_ACTION[action]) !== 0;
}

/** Strictly monotonic nonce progression the client follows (the program
 * rejects lower, equal, AND skipped-higher nonces for failed actions it
 * preserves, so the client never advances the nonce on a rejected action
 * unless the on-chain readback confirms consumption). */
export function nextNonce(status: SessionStatus, consumed: boolean): bigint {
  return status.nextExpectedNonce + (consumed ? 1n : 0n);
}
