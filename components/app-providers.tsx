"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) return children;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: { walletChainType: "solana-only", showWalletLoginFirst: true },
        embeddedWallets: { solana: { createOnLogin: "all-users" } }
      }}
    >
      {children}
    </PrivyProvider>
  );
}
