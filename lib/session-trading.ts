"use client";

/**
 * The end-to-end browser trading-session flow:
 *
 *   1. `createSession` -- create (or reuse) a browser-local Ed25519 session
 *      key (memory-only) and derive the canonical session PDA.
 *   2. `authorizeSessionTransaction` -- build `AuthorizeTradingSession`,
 *      wrap it in a v0 transaction paid by the owner's wallet, and request
 *      ONE main-wallet signature through the injected `WalletBoundary`
 *      (Privy). Everything after this point signs with the session key.
 *   3. `buildSessionSignedTransaction` -- assemble a v0 transaction whose
 *      fee payer is the Worker relayer's own (still-unsigned) slot, sign it
 *      with the session key, and hand it to the relayer, which
 *      independently re-validates (opcode allowlist, fee-payer identity,
 *      existing session signature) before co-signing the exact same
 *      message bytes and submitting.
 *   4. Revoke/withdraw/deposit are main-wallet-only: the relayer never
 *      accepts those opcodes, and the on-chain program rejects any session
 *      signer that touches them.
 *
 * Session private bytes never leave the browser (`browser-session.ts`).
 */

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  getBase58Encoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import { authorizeTradingSession, deriveTradingSession, revokeTradingSession } from "../clients/stockstream/src/index";
import {
  clearSessionKey,
  generateSessionKey,
  hasSessionKey,
  isSessionUsable,
  nextNonce,
  SESSION_ACTION,
  signWithSessionKey,
  type SessionPolicy,
  type SessionStatus,
} from "@/lib/browser-session";
import type { WalletBoundary } from "@/lib/execution-boundary";

export { SESSION_ACTION, isSessionUsable, nextNonce, hasSessionKey, clearSessionKey };
export type { SessionPolicy, SessionStatus };

export interface SessionKeyInfo {
  sessionPda: string;
  sessionSignerAddress: string;
  marketPda: string;
  seatIndex: number;
}

const sessionKeysByOwner = new Map<string, SessionKeyInfo>();

export function lookupSession(ownerWallet: string, marketPda: string, seatIndex: number): SessionKeyInfo | null {
  return sessionKeysByOwner.get(`${ownerWallet}:${marketPda}:${seatIndex}`) ?? null;
}

/** Creates (or reuses) the browser-local session key and derives the
 * canonical session PDA it will authorize against. No signature requested. */
export async function createSession(
  ownerWallet: string,
  marketPda: string,
  seatIndex: number,
): Promise<{ sessionPda: string; sessionSignerAddress: string; reused: boolean }> {
  const lookupKey = `${ownerWallet}:${marketPda}:${seatIndex}`;
  const existing = sessionKeysByOwner.get(lookupKey);
  if (existing && hasSessionKey(existing.sessionSignerAddress)) {
    return { sessionPda: existing.sessionPda, sessionSignerAddress: existing.sessionSignerAddress, reused: true };
  }
  const key = await generateSessionKey();
  const sessionPda = deriveTradingSession(ownerWallet, marketPda, seatIndex, key.address).toBase58();
  const info: SessionKeyInfo = { sessionPda, sessionSignerAddress: key.address, marketPda, seatIndex };
  sessionKeysByOwner.set(lookupKey, info);
  return { sessionPda, sessionSignerAddress: key.address, reused: false };
}

function assembleMessage(
  feePayer: string,
  instructions: readonly Instruction[],
  recentBlockhash: string,
): ReturnType<typeof compileTransaction> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer as never, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: recentBlockhash as never, lastValidBlockHeight: 2n ** 64n - 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions as never[], m),
  );
  return compileTransaction(message);
}

/** Adapts a web3.js `TransactionInstruction` (the client builders' output)
 * into the kit `Instruction` shape transaction assembly expects. */
export function toKitInstruction(ix: {
  keys: readonly { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[];
  programId: { toBase58(): string };
  data: Uint8Array;
}): Instruction {
  const role = (isSigner: boolean, isWritable: boolean) =>
    isSigner && isWritable ? 3 /* WRITABLE_SIGNER */ : isSigner ? 2 /* READONLY_SIGNER */ : isWritable ? 1 /* WRITABLE */ : 0 /* READONLY */;
  return {
    programAddress: ix.programId.toBase58() as never,
    accounts: ix.keys.map((key) => ({
      address: key.pubkey.toBase58() as never,
      role: role(key.isSigner, key.isWritable) as never,
    })),
    data: ix.data,
  };
}

/** Builds the `AuthorizeTradingSession` instruction, wraps it in a v0
 * transaction paid by the owner's wallet, and signs it through the main
 * wallet boundary. Returns the fully-signed base64 wire transaction. */
export async function authorizeSessionTransaction(
  input: {
    ownerWallet: string;
    marketPda: string;
    sessionPda: string;
    sessionSignerAddress: string;
    policy: SessionPolicy;
    /** Unix SECONDS, matching `TradingSession.expires_at` on-chain -- the
     * program compares it against the market's last verified oracle
     * timestamp, not wall-clock milliseconds. See
     * lib/browser-session.ts::SessionStatus.expiresAt for the full
     * explanation; getting this wrong makes a session valid ~1000x
     * longer than intended. */
    expiresAt: number;
    recentBlockhash: string;
  },
  mainWallet: WalletBoundary,
): Promise<{ base64: string }> {
  const clientIx = authorizeTradingSession(
    {
      market: input.marketPda,
      authority: input.ownerWallet,
      payer: input.ownerWallet,
      sessionSigner: input.sessionSignerAddress,
    },
    input.expiresAt,
    {
      seatIndex: input.policy.seatIndex,
      actions: input.policy.actions,
      maxOrderNotional: input.policy.maxOrderNotional,
      maxCumulativeNotional: input.policy.maxCumulativeNotional,
      maximumExposure: input.policy.maximumExposure,
      maximumOpenOrders: input.policy.maximumOpenOrders,
    },
  );
  const compiled = assembleMessage(input.ownerWallet, [toKitInstruction(clientIx)], input.recentBlockhash);
  // The main-wallet boundary returns the FULLY signed transaction bytes
  // (Privy signs and returns the signed wire form), not a bare signature:
  // pass them through verbatim. The wallet already signed the exact
  // compiled message this module assembled -- the relayer/trading paths
  // never see this transaction, and nothing here can alter it afterwards.
  const signedWire = await mainWallet.signTransaction(Uint8Array.from(compiled.messageBytes));
  if (signedWire.length === 0) throw new Error("main wallet returned an empty transaction");
  return { base64: bytesToBase64(new Uint8Array(signedWire)) };
}

/** The `RevokeTradingSession` instruction (main-wallet-signed; the relayer
 * never relays it). */
export function revokeSessionInstruction(input: {
  ownerWallet: string;
  marketPda: string;
  sessionPda: string;
  sessionSignerAddress: string;
}): Instruction {
  return toKitInstruction(
    revokeTradingSession(
      { market: input.marketPda, authority: input.ownerWallet, session: input.sessionPda, sessionSigner: input.sessionSignerAddress },
      0,
    ),
  );
}

/** Assembles a v0 transaction (fee payer = the relayer, still unsigned)
 * containing `instructions`, signs every required slot EXCEPT the fee payer
 * with the browser session key, and returns the base64 wire transaction for
 * the relayer. */
export async function buildSessionSignedTransaction(input: {
  sessionSignerAddress: string;
  relayerAddress: string;
  instructions: readonly Instruction[];
  recentBlockhash: string;
}): Promise<{ base64: string }> {
  const compiled = assembleMessage(input.relayerAddress, input.instructions, input.recentBlockhash);
  const sessionSignature = await signWithSessionKey(input.sessionSignerAddress, Uint8Array.from(compiled.messageBytes));
  const signed = {
    ...compiled,
    signatures: { ...compiled.signatures, [input.sessionSignerAddress]: sessionSignature },
  };
  return { base64: getBase64EncodedWireTransaction(signed as never) };
}

export interface SubmitToRelayerInput {
  csrfToken: string;
  /** A FRESH Privy access token (fetch one per call -- see AppAuth.getAccessToken).
   * The browser never holds the relayer's own bearer credential; this is
   * what actually authenticates the user to app/api/relay/session. */
  privyAccessToken: string;
  ownerWallet: string;
  transactionBase64: string;
  expectedProgramAddress: string;
  expectedMarket: string;
  expectedNonce: bigint;
  sessionSignerAddress: string;
  /** Client-generated idempotency key (crypto.randomUUID()) -- forwarded
   * so a retried submission can be deduplicated once the Worker supports
   * it (main-agent workstream item 1); this app does not dedupe it itself. */
  clientRequestId: string;
  domain: "l1" | "er";
}

export interface RelayResponse {
  status: number;
  body: { signature?: string; error?: string; detail?: string } | null;
}

/** Submits a session-signed transaction to the Worker relayer through this
 * app's own same-origin proxy (app/api/relay/session), which independently
 * verifies a fresh Privy access token on every call -- see that route's
 * own doc comment. Returns the raw status/body for the caller to classify
 * with lib/session-relay-status.ts rather than collapsing every non-2xx
 * outcome into one generic error string. */
export async function submitToRelayer(input: SubmitToRelayerInput): Promise<RelayResponse> {
  const response = await fetch("/api/relay/session", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "x-stockstream-csrf": input.csrfToken },
    body: JSON.stringify({
      privyAccessToken: input.privyAccessToken,
      ownerWallet: input.ownerWallet,
      transactionBase64: input.transactionBase64,
      expectedProgramAddress: input.expectedProgramAddress,
      expectedMarket: input.expectedMarket,
      expectedNonce: input.expectedNonce.toString(),
      sessionSignerAddress: input.sessionSignerAddress,
      clientRequestId: input.clientRequestId,
      domain: input.domain,
    }),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  const body = (await response.json().catch(() => null)) as RelayResponse["body"];
  return { status: response.status, body };
}

/** Destroys the in-memory session key (logout, revocation, expiry). */
export function destroySession(sessionSignerAddress: string): void {
  clearSessionKey(sessionSignerAddress);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export { getBase58Encoder, getBase58Decoder };
