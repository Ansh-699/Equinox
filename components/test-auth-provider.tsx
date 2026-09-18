"use client";

/**
 * Injectable test-mode auth adapter (spec section 18: "Use test adapters
 * in CI"). Active ONLY when NEXT_PUBLIC_E2E_TEST_MODE=1, which must never
 * be set in a real deployment -- it exists purely so Playwright can drive
 * the entire app (login, deposit, session authorize, session-signed
 * trading, withdraw) without a live Privy backend or a real wallet
 * extension. It never imports or calls any @privy-io/react-auth hook: the
 * real crash this was built to also fix (Privy's Solana hooks throwing
 * outside a PrivyProvider) is exactly the failure mode a half-mocked
 * Privy would still risk.
 *
 * The "main wallet" here is a real Ed25519 Solana keypair generated
 * client-side (crypto, not Privy) and held only in this module's memory,
 * signing real transaction bytes with @solana/web3.js -- structurally the
 * same thing a real wallet does, just without the Privy UI/network round
 * trip. window.__stockstreamE2E exposes the wallet address and a
 * main-wallet-prompt counter so tests can assert "exactly one signature
 * request" without reading application internals.
 */

import { useEffect, useMemo, useState, type Context } from "react";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { WalletSignerProvider, type ActiveWalletSigner } from "@/components/wallet-signer-context";
import type { AppAuth } from "@/components/app-providers";
import { readCsrfToken } from "@/lib/csrf";

export function isE2eTestMode(): boolean {
  return process.env.NEXT_PUBLIC_E2E_TEST_MODE === "1";
}

declare global {
  interface Window {
    __stockstreamE2E?: { walletAddress: string; promptCount: number };
  }
}

const testWallet = isE2eTestMode() ? Keypair.generate() : null;

export function TestAuthProvider({
  children,
  AuthContext,
  disabledAuth,
}: {
  children: React.ReactNode;
  AuthContext: Context<AppAuth>;
  disabledAuth: AppAuth;
}) {
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const walletAddress = testWallet?.publicKey.toBase58() ?? null;

  useEffect(() => {
    if (walletAddress && !window.__stockstreamE2E) window.__stockstreamE2E = { walletAddress, promptCount: 0 };
  }, [walletAddress]);

  const auth = useMemo<AppAuth>(() => ({
    ...disabledAuth,
    ready: true,
    authenticated: authenticated && sessionReady,
    walletAddress,
    walletClientType: "e2e-test",
    wallets: walletAddress ? [{ address: walletAddress, walletClientType: "e2e-test" }] : [],
    authError: null,
    login: () => {
      setAuthenticated(true);
      if (!walletAddress) return;
      void fetch("/api/auth/session", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: "e2e-test-token", walletAddress }),
      }).then((response) => setSessionReady(response.ok)).catch(() => setSessionReady(false));
    },
    logout: async () => {
      const csrf = readCsrfToken();
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: csrf ? { "x-stockstream-csrf": csrf } : {} });
      setAuthenticated(false);
      setSessionReady(false);
    },
    getAccessToken: async () => "e2e-test-token",
  }), [authenticated, sessionReady, walletAddress, disabledAuth]);

  const walletSigner = useMemo<ActiveWalletSigner>(() => ({
    address: walletAddress,
    signTransaction: async (bytes: Uint8Array) => {
      if (!testWallet) throw new Error("E2E test wallet not initialized");
      if (typeof window !== "undefined" && window.__stockstreamE2E) window.__stockstreamE2E.promptCount += 1;
      // `bytes` here is a FULL serialized transaction (empty signature
      // placeholders already allocated) -- lib/solana-transaction.ts's
      // encodeTransaction() produces exactly this shape to match Privy's
      // real signTransaction API, which PrivyWalletSigner passes through
      // untouched. Deserializing it as a bare compiled message (a
      // different shape used by the separate kit-based session-signing
      // path) silently decodes the wrong bytes and signs garbage.
      const transaction = VersionedTransaction.deserialize(bytes);
      transaction.sign([testWallet]);
      return transaction.serialize();
    },
  }), [walletAddress]);

  return (
    <AuthContext.Provider value={auth}>
      <WalletSignerProvider value={walletSigner}>{children}</WalletSignerProvider>
    </AuthContext.Provider>
  );
}
