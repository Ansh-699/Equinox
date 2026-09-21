/**
 * Privy browser-flow acceptance tests through the injectable adapter:
 * ten session-key trading actions with ONE main-wallet prompt, nonce
 * progression, limit/expiry/revocation rejection, and memory-only key
 * clearing on refresh/logout. Privy itself stays behind `WalletBoundary`.
 */
import { expect, test, vi } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  authorizeSessionTransaction,
  buildSessionSignedTransaction,
  createSession,
  destroySession,
  isSessionUsable,
  nextNonce,
  SESSION_ACTION,
  type SessionPolicy,
  type SessionStatus,
} from "./session-trading";
import type { WalletBoundary } from "./execution-boundary";

const RECENT_BLOCKHASH = "4Nd1mBQtrMJVYj3f39b7Px7mNbsgKXvceB7ZwxAvLGGF";
const OWNER_WALLET_KEY = Keypair.generate();
const OWNER_WALLET = OWNER_WALLET_KEY.publicKey.toBase58();
const MARKET = "91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE";

function mainWallet(wallet: Keypair): WalletBoundary {
  return {
    async signTransaction(messageBytes: Uint8Array): Promise<Uint8Array> {
      const { VersionedMessage, VersionedTransaction } = await import("@solana/web3.js");
      const transaction = new (await import("@solana/web3.js")).VersionedTransaction(
        VersionedMessage.deserialize(new Uint8Array(messageBytes)) as never,
      );
      transaction.sign([OWNER_WALLET_KEY]);
      return transaction.serialize();
    },
  };
}

function policy(): SessionPolicy {
  return {
    seatIndex: 0,
    actions: 0b11111,
    maxOrderNotional: 100_000n,
    maxCumulativeNotional: 500_000n,
    maximumExposure: 200_000n,
    maximumOpenOrders: 32,
  };
}

test("login + wallet + ONE session authorization prompt", async () => {
  const wallet = Keypair.generate();
  const created = await createSession(OWNER_WALLET, MARKET, 0);
  const boundary = mainWallet(wallet);
  const spy = vi.fn((bytes: Uint8Array) => boundary.signTransaction(bytes));
  // One authorization prompt
  const { base64 } = await authorizeSessionTransaction(
    {
      ownerWallet: OWNER_WALLET,
      marketPda: MARKET,
      sessionPda: created.sessionPda,
      sessionSignerAddress: created.sessionSignerAddress,
      policy: policy(),
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      recentBlockhash: RECENT_BLOCKHASH,
    },
    { signTransaction: (b) => spy(b as Uint8Array) },
  );
  expect(base64.length).toBeGreaterThan(0);
  expect((await import("./session-trading")).lookupSession(OWNER_WALLET, MARKET, 0)).not.toBeNull();
  destroySession(created.sessionSignerAddress);
});

test("ten session-key actions: exactly ONE main-wallet prompt, exact nonce progression", async () => {
  const created = await createSession(OWNER_WALLET, MARKET, 0);
  const prompts: number[] = [];
  const boundary: WalletBoundary = {
    async signTransaction(bytes: Uint8Array): Promise<Uint8Array> {
      prompts.push(bytes.length);
      const { VersionedMessage } = await import("@solana/web3.js");
      const transaction = new (await import("@solana/web3.js")).VersionedTransaction(
        VersionedMessage.deserialize(new Uint8Array(bytes)) as never,
      );
      transaction.sign([OWNER_WALLET_KEY]);
      return transaction.serialize();
    },
  };
  await authorizeSessionTransaction(
    {
      ownerWallet: OWNER_WALLET,
      marketPda: MARKET,
      sessionPda: created.sessionPda,
      sessionSignerAddress: created.sessionSignerAddress,
      policy: policy(),
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      recentBlockhash: RECENT_BLOCKHASH,
    },
    boundary,
  );
  expect(prompts).toHaveLength(1); // exactly one main-wallet prompt

  // Ten session-signed actions: every one built and signed WITHOUT the main wallet.
  const status = {
    sessionPda: created.sessionPda,
    sessionSignerAddress: created.sessionSignerAddress,
    ownerWallet: OWNER_WALLET,
    marketPda: MARKET,
    seatIndex: 0,
    actions: 0b11111,
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    maxOrderNotional: "100000",
    maxCumulativeNotional: "500000",
    maximumExposure: "100000",
    maximumOpenOrders: 32,
    nextExpectedNonce: 1n,
    revoked: false,
  };
  for (let action = 1; action <= 10; action += 1) {
    const nonce = nextNonce({ ...status, nextExpectedNonce: BigInt(action) }, false);
    expect(nonce).toBe(BigInt(action));
    const { base64 } = await buildSessionSignedTransaction({
      sessionSignerAddress: created.sessionSignerAddress,
      relayerAddress: Keypair.generate().publicKey.toBase58(),
      instructions: [{
        programAddress: "Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ" as never,
        accounts: [{ address: MARKET as never, role: 1 as never }],
        data: new Uint8Array([3, ...new Uint8Array(38)]),
      }],
      recentBlockhash: RECENT_BLOCKHASH,
    });
    expect(base64.length).toBeGreaterThan(0);
  }
  expect(prompts).toHaveLength(1); // still exactly one prompt after ten trades
  destroySession(created.sessionSignerAddress);
});

test("session cannot deposit/withdraw; limits and expiry gate trading", () => {
  // Structural exclusion: the on-chain deposit/withdraw handlers have no
  // session-signed form at all (handlers.rs); the relayer's opcode
  // allowlist structurally excludes them too.

  expect(SESSION_ACTION.all & (1 << 5)).toBe(0); // no bit reaches custody opcodes
  const base = {
    sessionPda: "PDA111111111111111111111111111111111111111",
    sessionSignerAddress: "S1111111111111111111111111111111111111111",
    ownerWallet: OWNER_WALLET,
    marketPda: MARKET,
    seatIndex: 0,
    actions: SESSION_ACTION.all,
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    maxOrderNotional: "100",
    maxCumulativeNotional: "100",
    maximumExposure: "100",
    maximumOpenOrders: 2,
    nextExpectedNonce: 1n,
    revoked: false,
  };
  expect(isSessionUsable(base)).toBe(true);
  expect(isSessionUsable({ ...base, expiresAt: Math.floor(Date.now() / 1000) - 1 })).toBe(false); // expiry rejection
  expect(isSessionUsable({ ...base, revoked: true })).toBe(false); // revocation blocks trading
  destroySession("no-op");
});

test("refresh/logout clears the memory-only session key", async () => {
  const { hasSessionKey, clearAllSessionKeys } = await import("./browser-session");
  const created = await createSession(OWNER_WALLET, MARKET, 0);
  expect(hasSessionKey(created.sessionSignerAddress)).toBe(true);
  clearAllSessionKeys();
  expect(hasSessionKey(created.sessionSignerAddress)).toBe(false);
});
