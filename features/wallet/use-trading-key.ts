"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Keypair } from "@solana/web3.js";
import type { AppAuth } from "@/components/auth-context";
import { loadTradingKey, saveTradingKey, tradingKeyFromSignature, tradingKeyMessage, tradingKeySigner } from "@/lib/trading-key";

/** The connected wallet's in-app trading key (see lib/trading-key.ts):
 * loaded silently when this browser already derived it, otherwise
 * `unlock()` asks the wallet for the one derivation signature. */
export function useTradingKey(auth: Pick<AppAuth, "walletAddress" | "signMessage">) {
  const wallet = auth.walletAddress;
  const [key, setKey] = useState<{ wallet: string; key: Keypair } | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    const stored = wallet ? loadTradingKey(wallet) : null;
    // localStorage is only readable after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKey(wallet && stored ? { wallet, key: stored } : null);
  }, [wallet]);

  const unlock = useCallback(async (): Promise<Keypair> => {
    if (!wallet) throw new Error("Connect a wallet first");
    const current = key?.wallet === wallet ? key.key : loadTradingKey(wallet);
    if (current) return current;
    setUnlocking(true);
    try {
      const signature = await auth.signMessage(wallet, new TextEncoder().encode(tradingKeyMessage(wallet)));
      const derived = await tradingKeyFromSignature(signature);
      saveTradingKey(wallet, derived);
      setKey({ wallet, key: derived });
      return derived;
    } finally {
      setUnlocking(false);
    }
  }, [auth, wallet, key]);

  const active = key && key.wallet === wallet ? key.key : null;
  const signer = useMemo(() => (active ? tradingKeySigner(active) : null), [active]);
  return { signer, unlock, unlocking };
}
