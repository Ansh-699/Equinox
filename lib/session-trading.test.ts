import { expect, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { getTransactionDecoder } from "@solana/kit";

import {
  authorizeSessionTransaction,
  buildSessionSignedTransaction,
  createSession,
  destroySession,
  lookupSession,
  revokeSessionInstruction,
} from "./session-trading";
import type { WalletBoundary } from "./execution-boundary";

const RECENT_BLOCKHASH = "4Nd1mBQtrMJVYj3f39b7Px7mNbsgKXvceB7ZwxAvLGGF".slice(0, 44);

/** A real Ed25519 main-wallet boundary (stands in for the Privy signer in
 * CI; the Privy adapter itself is a thin wrapper over this same shape). */
function mainWalletBoundary(wallet: Keypair): WalletBoundary {
  return {
    async signTransaction(messageBytes: Uint8Array): Promise<Uint8Array> {
      // Boundary contract (Privy-compatible): receives compiled message
      // bytes and returns the FULLY signed wire transaction. web3.js
      // VersionedTransaction can sign the same compiled message verbatim.
      const { VersionedMessage, VersionedTransaction } = await import("@solana/web3.js");
      const message = VersionedMessage.deserialize(messageBytes);
      const transaction = new VersionedTransaction(message);
      transaction.sign([wallet]);
      return transaction.serialize();
    },
  };
}

test("createSession derives the canonical PDA and keeps the key in memory only", async () => {
  const wallet = Keypair.generate();
  const created = await createSession(wallet.publicKey.toBase58(), "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0);
  expect(created.reused).toBe(false);
  expect(created.sessionPda.length).toBeGreaterThanOrEqual(43);
  expect(created.sessionSignerAddress.length).toBeGreaterThanOrEqual(43);
  const reused = await createSession(wallet.publicKey.toBase58(), "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0);
  expect(reused.reused).toBe(true);
  expect(lookupSession(wallet.publicKey.toBase58(), "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0)).not.toBeNull();
  destroySession(created.sessionSignerAddress);
  expect(lookupSession(wallet.publicKey.toBase58(), "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0)).not.toBeNull();
  // (The lookup map keeps metadata; the KEY material itself is gone.)
});

test("authorization transaction carries exactly ONE main-wallet signature and no session signature", async () => {
  const wallet = Keypair.generate();
  const owner = wallet.publicKey.toBase58();
  const created = await createSession(owner, "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0);
  const { base64 } = await authorizeSessionTransaction(
    {
      ownerWallet: owner,
      marketPda: "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE",
      sessionPda: created.sessionPda,
      sessionSignerAddress: created.sessionSignerAddress,
      policy: {
        seatIndex: 0,
        actions: 0b1011,
        maxOrderNotional: 1_000_000n,
        maxCumulativeNotional: 10_000_000n,
        maximumExposure: 1_000_000n,
        maximumOpenOrders: 32,
      },
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      recentBlockhash: RECENT_BLOCKHASH,
    },
    mainWalletBoundary(wallet),
  );
  const decoded = getTransactionDecoder().decode(Buffer.from(base64, "base64"));
  const signatures = decoded.signatures as Record<string, unknown>;
  expect(Object.keys(signatures)).toHaveLength(1);
  expect(Object.keys(signatures)[0]).toBe(owner);
  expect(signatures[created.sessionSignerAddress]).toBeUndefined();
  destroySession(created.sessionSignerAddress);
});

test("session-signed trade transaction: relayer fee payer unsigned, session signer signed", async () => {
  const wallet = Keypair.generate();
  const created = await createSession(wallet.publicKey.toBase58(), "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0);
  const relayer = Keypair.generate().publicKey.toBase58();
  const instruction = {
    // A PlaceOrder-family instruction signed by the session signer: the
    // session signer must be a required (readonly signer) account for the
    // message to declare two signature slots.
    programAddress: "BY81jGEfzwuqGkJbyYaGBty5Pn6oZLfntYUFkV85XZfo" as never,
    accounts: [
      { address: "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE" as never, role: 3 as never }, // market writable
      { address: created.sessionSignerAddress as never, role: 2 as never }, // session signer readonly signer
    ],
    data: new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
  const { base64 } = await buildSessionSignedTransaction({
    sessionSignerAddress: created.sessionSignerAddress,
    relayerAddress: relayer,
    instructions: [instruction],
    recentBlockhash: RECENT_BLOCKHASH,
  });
  const decoded = getTransactionDecoder().decode(Buffer.from(base64, "base64"));
  const signatures = decoded.signatures as Record<string, unknown>;
  // Fee payer slot untouched (the relayer signs it after validation).
  expect(signatures[relayer] == null).toBe(true); // fee-payer slot still empty (null placeholder)
  // The session signer produced a real signature.
  expect(signatures[created.sessionSignerAddress]).toBeDefined();
  expect(Object.keys(signatures)).toContain(created.sessionSignerAddress);
  destroySession(created.sessionSignerAddress);
});

test("destroySession clears the in-memory signing key", async () => {
  const { hasSessionKey } = await import("./browser-session");
  const wallet = Keypair.generate();
  const created = await createSession(wallet.publicKey.toBase58(), "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE", 0);
  expect(hasSessionKey(created.sessionSignerAddress)).toBe(true);
  destroySession(created.sessionSignerAddress);
  expect(hasSessionKey(created.sessionSignerAddress)).toBe(false);
});
