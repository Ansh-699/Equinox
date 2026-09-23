"use client";

/**
 * Injectable test-mode auth adapter (spec section 18: "Use test adapters
 * in CI"). Active ONLY when NEXT_PUBLIC_E2E_TEST_MODE=1, which must never
 * be set in a real deployment -- it exists purely so Playwright can drive
 * the entire app (login, deposit, session authorize, session-signed
 * trading, withdraw, wallet selection) without a live Privy backend or a
 * real wallet extension. It never imports or calls any @privy-io/react-auth
 * hook: the real crash this was built to also fix (Privy's Solana hooks
 * throwing outside a PrivyProvider) is exactly the failure mode a
 * half-mocked Privy would still risk.
 *
 * "Wallets" here are real Ed25519 Solana keypairs generated client-side
 * (crypto, not Privy) and held only in this module's memory, signing real
 * transaction bytes with @solana/web3.js -- structurally the same thing a
 * real wallet does, just without the Privy UI/network round trip. The
 * wallet COUNT is controlled by the `?e2eWallets=N` query param (default
 * 1) so a test can exercise the single-wallet auto-select path and the
 * multiple-wallet explicit-choice path without restarting the server.
 * window.__stockstreamE2E exposes wallet addresses and a
 * per-address signature counter so tests can assert things like "exactly
 * one main-wallet prompt" or "never signed with the wrong wallet" without
 * reading application internals.
 */

import { useEffect, useMemo, useState } from "react";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { PrivyIdentityContext, type PrivyIdentity, type DiscoveredWallet } from "@/components/privy-identity-context";

const TEST_WALLET_ICON = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#16794f"/></svg>');

export function isE2eTestMode(): boolean {
  return process.env.NEXT_PUBLIC_E2E_TEST_MODE === "1";
}

declare global {
  interface Window {
    __stockstreamE2E?: {
      walletAddresses: string[];
      /** @deprecated kept for older tests; equals walletAddresses[0]. */
      walletAddress: string;
      promptCount: number;
      promptsByAddress: Record<string, number>;
    };
  }
}

function walletCountFromLocation(): number {
  if (typeof window === "undefined") return 1;
  const raw = new URLSearchParams(window.location.search).get("e2eWallets");
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 5 ? parsed : 1;
}

// Deterministic per-index seeds (not random) -- a full page reload
// re-evaluates this module, and a persisted wallet-selection test needs the
// SAME address to still be there after reload, exactly like a real wallet
// extension that doesn't regenerate keys on every page load.
function testKeypair(index: number): Keypair {
  const seed = new Uint8Array(32);
  seed[0] = index + 1;
  return Keypair.fromSeed(seed);
}

const testWallets = isE2eTestMode() ? Array.from({ length: walletCountFromLocation() }, (_, index) => testKeypair(index)) : [];

export function TestAuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  // Real Privy only discovers wallets once the user is authenticated -- if
  // this stayed populated pre-login, AppAuth.wallets.length > 0 would look
  // identical to "authenticated but hasn't picked a wallet yet", which is
  // exactly the state the TopBar's "Choose wallet" affordance keys off of.
  const wallets = useMemo<readonly DiscoveredWallet[]>(
    () => (authenticated ? testWallets.map((wallet, index) => ({ address: wallet.publicKey.toBase58(), walletClientType: index === 0 ? "e2e-test-embedded" : "e2e-test-external" })) : []),
    [authenticated],
  );

  useEffect(() => {
    if (!wallets.length) return;
    const addresses = wallets.map((wallet) => wallet.address);
    window.__stockstreamE2E = { walletAddresses: addresses, walletAddress: addresses[0], promptCount: 0, promptsByAddress: Object.fromEntries(addresses.map((address) => [address, 0])) };
  }, [wallets]);

  const identity = useMemo<PrivyIdentity>(() => ({
    ready: true,
    privyAuthenticated: authenticated,
    directWallet: false,
    userId: authenticated ? "e2e-test-user" : null,
    userLabel: authenticated ? "e2e@stockstream.test" : null,
    wallets,
    authError: null,
    login: () => setAuthenticated(true),
    walletOptions: [{ name: "Test Wallet", icon: TEST_WALLET_ICON }],
    connectWith: async () => setAuthenticated(true),
    logout: async () => setAuthenticated(false),
    getAccessToken: async () => "e2e-test-token",
    signMessage: async () => { throw new Error("E2E wallets do not sign messages"); },
    signWith: async (address, bytes) => {
      const wallet = testWallets.find((candidate) => candidate.publicKey.toBase58() === address);
      if (!wallet) throw new Error(`E2E test wallet ${address} not found`);
      if (window.__stockstreamE2E) {
        window.__stockstreamE2E.promptCount += 1;
        window.__stockstreamE2E.promptsByAddress[address] = (window.__stockstreamE2E.promptsByAddress[address] ?? 0) + 1;
      }
      // `bytes` is a FULL serialized transaction (empty signature
      // placeholders already allocated) -- lib/solana-transaction.ts's
      // encodeTransaction() produces exactly this shape to match Privy's
      // real signTransaction API, which PrivyWalletSigner passes through
      // untouched. Deserializing it as a bare compiled message (a
      // different shape used by the separate kit-based session-signing
      // path) silently decodes the wrong bytes and signs garbage.
      const transaction = VersionedTransaction.deserialize(bytes);
      transaction.sign([wallet]);
      return transaction.serialize();
    },
  }), [authenticated, wallets]);

  return <PrivyIdentityContext.Provider value={identity}>{children}</PrivyIdentityContext.Provider>;
}
