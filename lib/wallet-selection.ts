import type { DiscoveredWallet } from "@/components/privy-identity-context";

/**
 * Pure selection derivation (spec section 6 / item 2): turns "which wallets
 * Privy discovered" plus "what the user explicitly chose, or previously
 * persisted" into the one effective active wallet. Extracted from
 * wallet-selection-context.tsx so it's unit-testable without mounting React.
 *
 * Rules, in priority order:
 *   1. Never authenticated -> null (no wallet is ever active pre-login).
 *   2. An explicit choice still present in the current wallet list wins.
 *   3. Else a persisted choice still present in the current wallet list.
 *   4. Else, if there is EXACTLY one wallet, auto-select it.
 *   5. Otherwise (multiple wallets, nothing valid chosen) -- null. Never
 *      wallets[0]: an unselected multi-wallet state must never silently sign
 *      with whichever wallet happened to be discovered first.
 */
export function resolveSelectedWallet(input: {
  privyAuthenticated: boolean;
  wallets: readonly DiscoveredWallet[];
  explicitSelection: string | null;
  storedAddress: string | null;
}): string | null {
  const { privyAuthenticated, wallets, explicitSelection, storedAddress } = input;
  if (!privyAuthenticated) return null;
  if (explicitSelection && wallets.some((wallet) => wallet.address === explicitSelection)) return explicitSelection;
  if (storedAddress && wallets.some((wallet) => wallet.address === storedAddress)) return storedAddress;
  if (wallets.length === 1) return wallets[0].address;
  return null;
}
