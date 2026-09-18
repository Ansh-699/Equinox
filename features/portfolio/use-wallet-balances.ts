"use client";

import { useEffect, useState } from "react";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const POLL_INTERVAL_MS = 15_000;

export interface WalletBalances {
  solLamports: bigint | null;
  collateralTokenBalance: bigint | null;
}

export function useWalletBalances(rpc: SolanaRpcTransport | null, walletAddress: string | null, collateralTokenAccount: string | null): WalletBalances {
  const [balances, setBalances] = useState<WalletBalances>({ solLamports: null, collateralTokenBalance: null });

  useEffect(() => {
    if (!rpc || !walletAddress) return;
    let stopped = false;
    const poll = () => {
      void Promise.all([
        rpc.solBalance(walletAddress).catch(() => null),
        collateralTokenAccount ? rpc.tokenBalance(collateralTokenAccount).catch(() => null) : Promise.resolve(null),
      ]).then(([solLamports, collateralTokenBalance]) => {
        if (!stopped) setBalances({ solLamports, collateralTokenBalance });
      });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [rpc, walletAddress, collateralTokenAccount]);

  return balances;
}
