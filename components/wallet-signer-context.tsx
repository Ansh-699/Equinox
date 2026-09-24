"use client";

import { createContext, useContext } from "react";
import type { WalletBoundary } from "@/lib/execution-boundary";

export interface ActiveWalletSigner extends WalletBoundary {
  address: string | null;
}

const NO_SIGNER: ActiveWalletSigner = {
  address: null,
  signTransaction: async () => { throw new Error("No wallet signer available"); },
};

/**
 * The active main wallet's signer, injected by AppProviders. Exists so
 * features/wallet/use-equinox-protocol.ts never calls
 * @privy-io/react-auth/solana's useSignTransaction/useWallets directly:
 * those hooks throw when called outside a real PrivyProvider, which used
 * to crash the whole trading terminal whenever NEXT_PUBLIC_PRIVY_APP_ID
 * was unset (Privy hooks called unconditionally deep in the tree, with no
 * PrivyProvider mounted in that branch). Routing through this context lets
 * AppProviders swap in a real Privy-backed signer, a test-mode fake
 * signer (NEXT_PUBLIC_E2E_TEST_MODE), or a safe "no signer" default --
 * all without any consumer component conditionally calling a hook.
 */
const WalletSignerContext = createContext<ActiveWalletSigner>(NO_SIGNER);

export const WalletSignerProvider = WalletSignerContext.Provider;
export function useActiveWalletSigner(): ActiveWalletSigner {
  return useContext(WalletSignerContext);
}
