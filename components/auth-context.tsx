"use client";

import { createContext, useContext } from "react";
import type { DiscoveredWallet } from "@/components/privy-identity-context";

export type { DiscoveredWallet };

export interface AppAuth {
  ready: boolean;
  /** Privy authenticated AND a wallet is selected AND the app session for
   * that wallet is established. A valid Privy login alone never implies
   * this -- see components/wallet-selection-context.tsx. */
  authenticated: boolean;
  userId: string | null;
  userLabel: string | null;
  /** Privy login completed (a wallet can be connected without it). */
  privyAuthenticated: boolean;
  /** The SELECTED wallet's address (see useWalletSelection), not merely
   * the first discovered one. Null until the user has an unambiguous or
   * explicit choice. */
  walletAddress: string | null;
  walletClientType: string | null;
  /** Every wallet Privy has discovered for this user, not just the active one. */
  wallets: readonly DiscoveredWallet[];
  authError: string | null;
  login: () => void;
  walletOptions: readonly { name: string; icon: string }[];
  connectWith: (walletName: string) => Promise<void>;
  logout: () => Promise<void>;
  signMessage: (address: string, bytes: Uint8Array) => Promise<Uint8Array>;
  /** A fresh, short-lived Privy access token for this request -- callers
   * (e.g. the session relayer) must fetch one per request rather than
   * caching it: it is the per-request user-authentication proof, not a
   * substitute for the backend's own authoritative validation. */
  getAccessToken: () => Promise<string | null>;
}

export const disabledAuth: AppAuth = {
  ready: true,
  authenticated: false,
  userId: null,
  userLabel: null,
  privyAuthenticated: false,
  walletAddress: null,
  walletClientType: null,
  wallets: [],
  authError: "Privy is not configured",
  login: () => undefined,
  walletOptions: [],
  connectWith: async () => undefined,
  logout: async () => undefined,
  signMessage: async () => { throw new Error("No wallet connected"); },
  getAccessToken: async () => null,
};

export const AuthContext = createContext<AppAuth>(disabledAuth);
export function useAppAuth(): AppAuth {
  return useContext(AuthContext);
}
