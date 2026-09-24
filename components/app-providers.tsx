"use client";

import "@/lib/browser-polyfills";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { PrivyProvider, useLogin, useLoginWithSiws, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import { useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { PrivyWalletSigner } from "@/lib/privy-signing";
import { connectWallet, disconnectWallet, rememberWallet, rememberedWallet, getServerSolanaWalletsSnapshot, getSolanaWalletsSnapshot, signMessageWith, signTransactionWith, subscribeSolanaWallets, toBase64 } from "@/lib/standard-wallets";
import { PrivyIdentityContext, disabledIdentity, type PrivyIdentity } from "@/components/privy-identity-context";
import { WalletSelectionProvider } from "@/components/wallet-selection-context";
import { TestAuthProvider, isE2eTestMode } from "@/components/test-auth-provider";

export { useAppAuth, type AppAuth, type DiscoveredWallet } from "@/components/auth-context";
export { useWalletSelection, type WalletSelection } from "@/components/wallet-selection-context";

type LoginMethod = "email" | "google" | "wallet";
const LOGIN_METHODS: LoginMethod[] = (process.env.NEXT_PUBLIC_PRIVY_LOGIN_METHODS ?? "email,wallet")
  .split(",").map((method) => method.trim()).filter((method): method is LoginMethod => ["email", "google", "wallet"].includes(method));

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
        // Must match the login methods enabled in the Privy dashboard: offering a
        // disabled one (e.g. Solana wallet login) fails with "Could not log in with wallet".
        loginMethods: LOGIN_METHODS,
        appearance: { walletChainType: "solana-only", showWalletLoginFirst: true, walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets"] },
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
 * never from features/wallet/use-equinox-protocol.ts directly, which
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
  const [authError, setAuthError] = useState<string | null>(null);
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws();
  const installed = useSyncExternalStore(subscribeSolanaWallets, getSolanaWalletsSnapshot, getServerSolanaWalletsSnapshot);
  // The one browser wallet the user picked in the wallet drawer (Wallet
  // Standard). It trades directly; Privy SIWS links it when that login method
  // is enabled, but connecting never depends on it.
  const [standard, setStandard] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);
  const embedded = useMemo(
    () => (authenticated ? solanaWallets.filter((wallet) => rootWallets.find((root) => root.address === wallet.address)?.walletClientType === "privy") : []),
    [authenticated, solanaWallets, rootWallets],
  );

  // Returning visitors: reconnect silently to the wallet they last chose.
  useEffect(() => {
    const name = rememberedWallet();
    const option = name ? installed.find((candidate) => candidate.name === name) : undefined;
    if (!option || standard) return;
    let cancelled = false;
    connectWallet(option.wallet, true).then((account) => { if (!cancelled) setStandard({ wallet: option.wallet, account }); }).catch(() => rememberWallet(null));
    return () => { cancelled = true; };
  }, [installed, standard]);

  const identity = useMemo<PrivyIdentity>(() => ({
    ready,
    privyAuthenticated: authenticated,
    directWallet: standard !== null,
    userId: user?.id ?? null,
    userLabel: user?.email?.address ?? user?.google?.email ?? null,
    // Exactly one active wallet: the picked browser wallet, else Privy's embedded one.
    wallets: standard
      ? [{ address: standard.account.address, walletClientType: standard.wallet.name.toLowerCase() }]
      : embedded.map((wallet) => ({ address: wallet.address, walletClientType: "privy" })),
    authError,
    login,
    walletOptions: installed.map(({ name, icon }) => ({ name, icon })),
    connectWith: async (walletName) => {
      const option = installed.find((candidate) => candidate.name === walletName);
      if (!option) throw new Error(`${walletName} is not installed`);
      setAuthError(null);
      if (standard && standard.wallet !== option.wallet) await disconnectWallet(standard.wallet);
      const account = await connectWallet(option.wallet);
      setStandard({ wallet: option.wallet, account });
      rememberWallet(walletName);
      // Best effort: link the wallet to a Privy identity. Fails (harmlessly)
      // while Solana wallet login is disabled in the Privy dashboard.
      if (!authenticated) {
        try {
          const message = await generateSiwsMessage({ address: account.address });
          const signature = await signMessageWith(option.wallet, account, new TextEncoder().encode(message));
          await loginWithSiws({ signature: toBase64(signature), message, walletClientType: walletName.toLowerCase(), connectorType: "injected" });
        } catch (error) {
          setAuthError(`Privy sign-in skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    signMessage: async (address, bytes) => {
      if (standard?.account.address !== address || !standard) throw new Error("Only the connected browser wallet can sign messages");
      return signMessageWith(standard.wallet, standard.account, bytes);
    },
    logout: async () => {
      if (standard) await disconnectWallet(standard.wallet);
      setStandard(null);
      rememberWallet(null);
      if (authenticated) await privyLogout();
    },
    getAccessToken: async () => { try { return await getAccessToken(); } catch { return null; } },
    signWith: async (address, bytes) => {
      if (standard?.account.address === address) return signTransactionWith(standard.wallet, standard.account, bytes);
      const wallet = embedded.find((candidate) => candidate.address === address);
      if (!wallet) throw new Error(`Wallet ${address} is not connected`);
      const signer = new PrivyWalletSigner(signSolanaTransaction, wallet, "solana:devnet");
      return signer.signTransaction(bytes);
    },
  }), [ready, authenticated, user?.id, user?.email?.address, user?.google?.email, installed, standard, embedded, generateSiwsMessage, loginWithSiws, authError, login, privyLogout, getAccessToken, signSolanaTransaction]);

  return <PrivyIdentityContext.Provider value={identity}>{children}</PrivyIdentityContext.Provider>;
}
