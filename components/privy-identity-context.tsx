"use client";

import { createContext, useContext } from "react";

export interface DiscoveredWallet {
  address: string;
  walletClientType: string;
}

/**
 * Internal-only identity layer, one level below the public AppAuth
 * (components/app-providers.tsx). Both the real Privy branch and
 * test-mode feed into this same shape; WalletSelectionProvider is the
 * ONLY consumer, and it is what turns "which wallets exist" into "which
 * one is active" and produces the public AppAuth + the actual signer.
 * Nothing else should read this context directly -- in particular,
 * `walletAddress`/signing must always go through the selection layer, or
 * a component could silently use the first discovered wallet instead of
 * the one the user actually chose.
 */
export interface PrivyIdentity {
  ready: boolean;
  /** Privy-level authentication only -- NOT the same as AppAuth.authenticated,
   * which also requires a wallet to be selected and an app session established
   * for it. */
  privyAuthenticated: boolean;
  /** A browser wallet is connected directly (Wallet Standard): it is the session, Privy or not. */
  directWallet: boolean;
  userId: string | null;
  /** The Privy login the user signed in with (email, Google, or wallet), for display. */
  userLabel: string | null;
  wallets: readonly DiscoveredWallet[];
  authError: string | null;
  login: () => void;
  /** Installed Solana wallets (name + icon) the connect drawer can offer. */
  walletOptions: readonly { name: string; icon: string }[];
  /** Connect one wallet and sign in with it (one signature, no Privy modal). */
  connectWith: (walletName: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Signs an arbitrary message with the directly connected wallet. */
  signMessage: (address: string, bytes: Uint8Array) => Promise<Uint8Array>;
  getAccessToken: () => Promise<string | null>;
  /** Signs with a SPECIFIC wallet by address -- never "the active one" at
   * this layer, since this layer doesn't know about selection. */
  signWith: (address: string, bytes: Uint8Array) => Promise<Uint8Array>;
}

export const disabledIdentity: PrivyIdentity = {
  ready: true,
  privyAuthenticated: false,
  directWallet: false,
  userId: null,
  userLabel: null,
  wallets: [],
  authError: "Privy is not configured",
  login: () => undefined,
  walletOptions: [],
  connectWith: async () => undefined,
  logout: async () => undefined,
  signMessage: async () => { throw new Error("No wallet connected"); },
  getAccessToken: async () => null,
  signWith: async () => { throw new Error("No wallet signer available"); },
};

export const PrivyIdentityContext = createContext<PrivyIdentity>(disabledIdentity);
export function usePrivyIdentity(): PrivyIdentity {
  return useContext(PrivyIdentityContext);
}
