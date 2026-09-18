"use client";

import "@/lib/browser-polyfills";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PrivyProvider, useLogin, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { readCsrfToken } from "@/lib/csrf";
import { PrivyWalletSigner } from "@/lib/privy-signing";
import { WalletSignerProvider, type ActiveWalletSigner } from "@/components/wallet-signer-context";
import { TestAuthProvider, isE2eTestMode } from "@/components/test-auth-provider";

export interface DiscoveredWallet {
  address: string;
  walletClientType: string;
}

export interface AppAuth {
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  walletAddress: string | null;
  /** e.g. "privy" (embedded) vs "phantom"/"metamask"/etc (external). Null
   * until a wallet is connected. */
  walletClientType: string | null;
  /** Every wallet Privy has discovered for this user, not just the active
   * one -- Settings/diagnostics surfaces need this even though trading
   * still only ever signs with wallets[0] (full wallet-switching UI is a
   * further increment). */
  wallets: readonly DiscoveredWallet[];
  authError: string | null;
  login: () => void;
  logout: () => Promise<void>;
  /** A fresh, short-lived Privy access token for this request -- callers
   * (e.g. the session relayer) must fetch one per request rather than
   * caching it: it is the per-request user-authentication proof, not a
   * substitute for the backend's own authoritative validation. */
  getAccessToken: () => Promise<string | null>;
}

const disabledAuth: AppAuth = { ready: true, authenticated: false, userId: null, walletAddress: null, walletClientType: null, wallets: [], authError: "Privy is not configured", login: () => undefined, logout: async () => undefined, getAccessToken: async () => null };
const AuthContext = createContext<AppAuth>(disabledAuth);

export function useAppAuth() { return useContext(AuthContext); }

export function AppProviders({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  // Test-mode replaces Privy entirely -- it must never call any
  // @privy-io/react-auth hook, real or otherwise, so browser tests never
  // depend on a live Privy backend. See components/test-auth-provider.tsx.
  if (isE2eTestMode()) return <TestAuthProvider AuthContext={AuthContext} disabledAuth={disabledAuth}>{children}</TestAuthProvider>;

  // No PrivyProvider is mounted on this branch, so nothing downstream may
  // call an @privy-io/react-auth/solana hook (they throw without a
  // provider ancestor) -- WalletSignerContext's own default ("no signer
  // available") is correct here without an explicit provider.
  if (!appId) return <AuthContext.Provider value={disabledAuth}>{children}</AuthContext.Provider>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: { walletChainType: "solana-only", showWalletLoginFirst: true },
    externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } }
      }}
    >
      <PrivySession>{children}</PrivySession>
    </PrivyProvider>
  );
}

function PrivySession({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { login } = useLogin();
  const { logout: privyLogout } = useLogout();
  const { wallets } = useWallets();
  // The Solana-specific wallet/signing views (@privy-io/react-auth/solana)
  // are only ever called from here, inside a component guaranteed to have
  // a real PrivyProvider ancestor -- never from
  // features/wallet/use-stockstream-protocol.ts directly, which used to
  // crash the entire trading terminal whenever NEXT_PUBLIC_PRIVY_APP_ID
  // was unset (these hooks throw outside a PrivyProvider).
  const { signTransaction: signSolanaTransaction } = useSignTransaction();
  const { wallets: solanaWallets } = useSolanaWallets();
  const [sessionReady, setSessionReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const walletAddress = wallets[0]?.address ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!ready || !authenticated || !walletAddress) return () => { cancelled = true; };
    void getAccessToken().then(async (accessToken) => {
      if (!accessToken) throw new Error("Privy access token unavailable");
      const response = await fetch("/api/auth/session", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken, walletAddress }) });
      if (!response.ok) throw new Error("Application session could not be created");
      if (!cancelled) { setAuthError(null); setSessionReady(true); }
    }).catch((error: unknown) => { if (!cancelled) { setAuthError(error instanceof Error ? error.message : "Authentication failed"); setSessionReady(false); } });
    return () => { cancelled = true; };
  }, [authenticated, getAccessToken, ready, walletAddress]);

  const value = useMemo<AppAuth>(() => ({
    ready: ready && sessionReady,
    authenticated: authenticated && sessionReady && !!walletAddress,
    userId: user?.id ?? null,
    walletAddress,
    walletClientType: wallets[0]?.walletClientType ?? null,
    wallets: wallets.map((wallet) => ({ address: wallet.address, walletClientType: wallet.walletClientType })),
    authError,
    login,
    logout: async () => { const csrf = readCsrfToken(); await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: csrf ? { "x-stockstream-csrf": csrf } : {} }); await privyLogout(); setSessionReady(false); },
    getAccessToken: async () => { try { return await getAccessToken(); } catch { return null; } },
  }), [authenticated, authError, getAccessToken, login, privyLogout, ready, sessionReady, user?.id, walletAddress, wallets]);

  const activeSolanaWallet = solanaWallets[0];
  const walletSigner = useMemo<ActiveWalletSigner>(() => {
    if (!activeSolanaWallet) return { address: null, signTransaction: async () => { throw new Error("No Solana wallet connected"); } };
    const signer = new PrivyWalletSigner(signSolanaTransaction, activeSolanaWallet, "solana:devnet");
    return { address: activeSolanaWallet.address, signTransaction: (bytes) => signer.signTransaction(bytes) };
  }, [activeSolanaWallet, signSolanaTransaction]);

  return (
    <AuthContext.Provider value={value}>
      <WalletSignerProvider value={walletSigner}>{children}</WalletSignerProvider>
    </AuthContext.Provider>
  );
}
