"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { disabledIdentity, PrivyIdentityContext, type PrivyIdentity } from "@/components/privy-identity-context";
import {
  connectWallet,
  disconnectWallet,
  getServerSolanaWalletsSnapshot,
  getSolanaWalletsSnapshot,
  rememberedWallet,
  rememberWallet,
  signMessageWith,
  signTransactionWith,
  subscribeSolanaWallets,
  type SolanaWalletOption,
} from "@/lib/standard-wallets";

export interface StandardWalletState {
  installed: SolanaWalletOption[];
  standard: { wallet: Wallet; account: WalletAccount } | null;
  /** Connects the named installed wallet and remembers it for next visit. */
  connect: (walletName: string) => Promise<{ wallet: Wallet; account: WalletAccount }>;
  disconnect: () => Promise<void>;
}

/** The one browser wallet picked in the wallet drawer (Wallet Standard).
 * Works with or without Privy: it trades directly, and a returning visitor
 * reconnects silently to the wallet they last chose. */
export function useStandardWallet(): StandardWalletState {
  const installed = useSyncExternalStore(subscribeSolanaWallets, getSolanaWalletsSnapshot, getServerSolanaWalletsSnapshot);
  const [standard, setStandard] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);

  useEffect(() => {
    const name = rememberedWallet();
    const option = name ? installed.find((candidate) => candidate.name === name) : undefined;
    if (!option || standard) return;
    let cancelled = false;
    connectWallet(option.wallet, true).then((account) => { if (!cancelled) setStandard({ wallet: option.wallet, account }); }).catch(() => rememberWallet(null));
    return () => { cancelled = true; };
  }, [installed, standard]);

  const connect = useCallback(async (walletName: string) => {
    const option = installed.find((candidate) => candidate.name === walletName);
    if (!option) throw new Error(`${walletName} is not installed`);
    if (standard && standard.wallet !== option.wallet) await disconnectWallet(standard.wallet);
    const account = await connectWallet(option.wallet);
    const next = { wallet: option.wallet, account };
    setStandard(next);
    rememberWallet(walletName);
    return next;
  }, [installed, standard]);

  const disconnect = useCallback(async () => {
    if (standard) await disconnectWallet(standard.wallet);
    setStandard(null);
    rememberWallet(null);
  }, [standard]);

  return { installed, standard, connect, disconnect };
}

/** Identity when Privy is not configured (no NEXT_PUBLIC_PRIVY_APP_ID):
 * browser wallets still connect and sign directly, so the app stays usable. */
export function DirectWalletBridge({ children }: { children: React.ReactNode }) {
  const { installed, standard, connect, disconnect } = useStandardWallet();
  const identity = useMemo<PrivyIdentity>(() => ({
    ...disabledIdentity,
    authError: null,
    directWallet: standard !== null,
    wallets: standard ? [{ address: standard.account.address, walletClientType: standard.wallet.name.toLowerCase() }] : [],
    walletOptions: installed.map(({ name, icon }) => ({ name, icon })),
    connectWith: async (walletName) => { await connect(walletName); },
    logout: disconnect,
    signMessage: async (address, bytes) => {
      if (!standard || standard.account.address !== address) throw new Error("Only the connected browser wallet can sign messages");
      return signMessageWith(standard.wallet, standard.account, bytes);
    },
    signWith: async (address, bytes) => {
      if (!standard || standard.account.address !== address) throw new Error(`Wallet ${address} is not connected`);
      return signTransactionWith(standard.wallet, standard.account, bytes);
    },
  }), [installed, standard, connect, disconnect]);
  return <PrivyIdentityContext.Provider value={identity}>{children}</PrivyIdentityContext.Provider>;
}
