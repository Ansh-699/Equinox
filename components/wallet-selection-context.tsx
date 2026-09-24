"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePrivyIdentity, type DiscoveredWallet } from "@/components/privy-identity-context";
import { WalletSignerProvider, type ActiveWalletSigner } from "@/components/wallet-signer-context";
import { AuthContext, type AppAuth } from "@/components/auth-context";
import { readCsrfToken } from "@/lib/csrf";
import { readStoredWallet, storeSelectedWallet } from "@/lib/wallet-storage";
import { resolveSelectedWallet } from "@/lib/wallet-selection";

export interface WalletSelection {
  wallets: readonly DiscoveredWallet[];
  selectedAddress: string | null;
  selectWallet: (address: string) => void;
  clearSelection: () => void;
}

const disabledSelection: WalletSelection = {
  wallets: [],
  selectedAddress: null,
  selectWallet: () => undefined,
  clearSelection: () => undefined,
};

const WalletSelectionContext = createContext<WalletSelection>(disabledSelection);
export function useWalletSelection(): WalletSelection {
  return useContext(WalletSelectionContext);
}

/**
 * Turns "which wallets Privy discovered" into "which one the user actually
 * chose to trade with" -- the single source of truth AppAuth.walletAddress,
 * the trading signer, and the app session all derive from.
 *
 * The effective selection is a PURE derivation (explicit choice, else a
 * still-valid persisted choice, else auto-select when there's exactly one
 * wallet, else null), not state synced via an effect -- so there is
 * nothing to "clear" when a wallet disappears: the derivation simply stops
 * yielding it, the moment `identity.wallets` changes, with no
 * stale-render window. Rules, per spec:
 *   - Restore a persisted selection ONLY if that wallet is still present
 *     in the current (authenticated) wallet list.
 *   - Exactly one discovered wallet: auto-select it (no real ambiguity).
 *   - More than one, nothing valid persisted or explicitly chosen: fail
 *     closed -- selectedAddress is null until the user explicitly
 *     chooses, never silently wallets[0].
 *   - A previously-selected wallet disappearing from the list (disconnected,
 *     or a different Privy account) makes the derivation stop returning it
 *     rather than silently falling back to another wallet.
 *   - Logout clears the explicit choice.
 */
export function WalletSelectionProvider({ children }: { children: React.ReactNode }) {
  const identity = usePrivyIdentity();
  const [explicitSelection, setExplicitSelection] = useState<string | null>(null);
  // Keyed to the address it was confirmed for -- comparing against the
  // CURRENT selectedAddress (not a plain boolean) means switching wallets
  // makes `authenticated` false immediately, with no separate synchronous
  // reset needed: the old address simply stops matching.
  const [sessionReadyForAddress, setSessionReadyForAddress] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const selectedAddress = useMemo<string | null>(
    () => identity.directWallet
      ? identity.wallets[0]?.address ?? null // the one picked browser wallet
      : resolveSelectedWallet({ privyAuthenticated: identity.privyAuthenticated, wallets: identity.wallets, explicitSelection, storedAddress: readStoredWallet() }),
    [identity.directWallet, identity.privyAuthenticated, identity.wallets, explicitSelection],
  );

  const selectWallet = useCallback((address: string) => {
    if (!identity.wallets.some((wallet) => wallet.address === address)) return; // can't select an unknown wallet
    setExplicitSelection(address);
    storeSelectedWallet(address);
  }, [identity.wallets]);

  const clearSelection = useCallback(() => {
    setExplicitSelection(null);
    storeSelectedWallet(null);
  }, []);

  // The app session (app/api/auth/session) is bound to a specific wallet
  // address server-side (checked on every relay call) -- it must be
  // re-established whenever the selected wallet changes, not just once at
  // login, or switching wallets would leave every session-signed request
  // failing authentication_required against the OLD wallet's session.
  useEffect(() => {
    let cancelled = false;
    if (!identity.privyAuthenticated || !selectedAddress) return () => { cancelled = true; };
    void identity.getAccessToken().then(async (accessToken) => {
      if (!accessToken) throw new Error("Privy access token unavailable");
      const response = await fetch("/api/auth/session", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken, walletAddress: selectedAddress }) });
      if (!response.ok) throw new Error("Application session could not be created");
      if (!cancelled) { setSessionError(null); setSessionReadyForAddress(selectedAddress); }
    }).catch((error: unknown) => { if (!cancelled) { setSessionError(error instanceof Error ? error.message : "Authentication failed"); } });
    return () => { cancelled = true; };
  }, [identity, selectedAddress]);

  const auth = useMemo<AppAuth>(() => ({
    ready: identity.ready,
    // A directly connected wallet signs its own transactions; the Privy app
    // session only gates the legacy session-key relayer.
    authenticated: !!selectedAddress && (identity.directWallet || (identity.privyAuthenticated && sessionReadyForAddress === selectedAddress)),
    userId: identity.userId,
    userLabel: identity.userLabel,
    privyAuthenticated: identity.privyAuthenticated,
    signMessage: identity.signMessage,
    walletAddress: selectedAddress,
    walletClientType: identity.wallets.find((wallet) => wallet.address === selectedAddress)?.walletClientType ?? null,
    wallets: identity.wallets,
    authError: identity.authError ?? sessionError,
    login: identity.login,
    walletOptions: identity.walletOptions,
    connectWith: identity.connectWith,
    logout: async () => {
      const csrf = readCsrfToken();
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: csrf ? { "x-equinox-csrf": csrf } : {} });
      await identity.logout();
      clearSelection();
    },
    getAccessToken: identity.getAccessToken,
  }), [identity, selectedAddress, sessionReadyForAddress, sessionError, clearSelection]);

  const signer = useMemo<ActiveWalletSigner>(() => {
    if (!auth.authenticated || !selectedAddress) return { address: null, signTransaction: async () => { throw new Error("No wallet selected"); } };
    return { address: selectedAddress, signTransaction: (bytes) => identity.signWith(selectedAddress, bytes) };
  }, [auth.authenticated, selectedAddress, identity]);

  const selection = useMemo<WalletSelection>(() => ({
    wallets: identity.wallets,
    selectedAddress,
    selectWallet,
    clearSelection,
  }), [identity.wallets, selectedAddress, selectWallet, clearSelection]);

  return (
    <AuthContext.Provider value={auth}>
      <WalletSignerProvider value={signer}>
        <WalletSelectionContext.Provider value={selection}>{children}</WalletSelectionContext.Provider>
      </WalletSignerProvider>
    </AuthContext.Provider>
  );
}
