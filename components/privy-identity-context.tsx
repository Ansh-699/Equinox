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
  userId: string | null;
  wallets: readonly DiscoveredWallet[];
  authError: string | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** Signs with a SPECIFIC wallet by address -- never "the active one" at
   * this layer, since this layer doesn't know about selection. */
  signWith: (address: string, bytes: Uint8Array) => Promise<Uint8Array>;
}

export const disabledIdentity: PrivyIdentity = {
  ready: true,
  privyAuthenticated: false,
  userId: null,
  wallets: [],
  authError: "Privy is not configured",
  login: () => undefined,
  logout: async () => undefined,
  getAccessToken: async () => null,
  signWith: async () => { throw new Error("No wallet signer available"); },
};

export const PrivyIdentityContext = createContext<PrivyIdentity>(disabledIdentity);
export function usePrivyIdentity(): PrivyIdentity {
  return useContext(PrivyIdentityContext);
}
