"use client";

import "@/lib/browser-polyfills";
import { useMemo, useState } from "react";
import { PrivyProvider, useLogin, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { PrivyWalletSigner } from "@/lib/privy-signing";
import { PrivyIdentityContext, disabledIdentity, type PrivyIdentity } from "@/components/privy-identity-context";
import { WalletSelectionProvider } from "@/components/wallet-selection-context";
import { TestAuthProvider, isE2eTestMode } from "@/components/test-auth-provider";

export { useAppAuth, type AppAuth, type DiscoveredWallet } from "@/components/auth-context";
export { useWalletSelection, type WalletSelection } from "@/components/wallet-selection-context";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  // Test-mode replaces Privy entirely -- it must never call any
  // @privy-io/react-auth hook, real or otherwise, so browser tests never
  // depend on a live Privy backend. See components/test-auth-provider.tsx.
  // It still goes through WalletSelectionProvider like every other branch:
  // wallet selection is exactly what browser tests need to exercise, not
  // something test mode should bypass.
  if (isE2eTestMode()) {
    return (
      <TestAuthProvider>
        <WalletSelectionProvider>{children}</WalletSelectionProvider>
      </TestAuthProvider>
    );
  }

  // No PrivyProvider is mounted on this branch, so nothing downstream may
  // call an @privy-io/react-auth/solana hook (they throw without a
  // provider ancestor) -- disabledIdentity has an empty wallet list, so
  // WalletSelectionProvider's own logic naturally yields "not authenticated,
  // no wallet" without ever touching Privy.
  if (!appId) {
    return (
      <PrivyIdentityContext.Provider value={disabledIdentity}>
        <WalletSelectionProvider>{children}</WalletSelectionProvider>
      </PrivyIdentityContext.Provider>
    );
  }

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
      <PrivyIdentityBridge>
        <WalletSelectionProvider>{children}</WalletSelectionProvider>
      </PrivyIdentityBridge>
    </PrivyProvider>
  );
}

/** Bridges real Privy hooks into PrivyIdentityContext. The Solana-specific
 * views (@privy-io/react-auth/solana) are only ever called from here,
 * inside a component guaranteed to have a real PrivyProvider ancestor --
 * never from features/wallet/use-stockstream-protocol.ts directly, which
 * used to crash the entire trading terminal whenever
 * NEXT_PUBLIC_PRIVY_APP_ID was unset (those hooks throw outside a
 * PrivyProvider). This component intentionally knows nothing about wallet
 * SELECTION -- it only reports what Privy discovered and how to sign with
 * a given one; WalletSelectionProvider decides which one is active. */
function PrivyIdentityBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { login } = useLogin();
  const { logout: privyLogout } = useLogout();
  const { signTransaction: signSolanaTransaction } = useSignTransaction();
  const { wallets: solanaWallets } = useSolanaWallets();
  // The root useWallets() (not the /solana-specific one above) is the only
  // place walletClientType ("privy" embedded vs "phantom"/"metamask"/etc
  // external) is exposed; it's correlated by address to the actual signing
  // wallets from the /solana view rather than assumed.
  const { wallets: rootWallets } = useWallets();
  const [authError] = useState<string | null>(null);

  const identity = useMemo<PrivyIdentity>(() => ({
    ready,
    privyAuthenticated: authenticated,
    userId: user?.id ?? null,
    wallets: solanaWallets.map((wallet) => ({
      address: wallet.address,
      walletClientType: rootWallets.find((candidate) => candidate.address === wallet.address)?.walletClientType ?? "unknown",
    })),
    authError,
    login,
    logout: async () => { await privyLogout(); },
    getAccessToken: async () => { try { return await getAccessToken(); } catch { return null; } },
    signWith: async (address, bytes) => {
      const wallet = solanaWallets.find((candidate) => candidate.address === address);
      if (!wallet) throw new Error(`Wallet ${address} is not connected`);
      const signer = new PrivyWalletSigner(signSolanaTransaction, wallet, "solana:devnet");
      return signer.signTransaction(bytes);
    },
  }), [ready, authenticated, user?.id, solanaWallets, rootWallets, authError, login, privyLogout, getAccessToken, signSolanaTransaction]);

  return <PrivyIdentityContext.Provider value={identity}>{children}</PrivyIdentityContext.Provider>;
}
