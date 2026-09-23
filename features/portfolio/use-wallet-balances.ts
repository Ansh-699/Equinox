"use client";

import { useEffect, useState } from "react";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const POLL_INTERVAL_MS = 5_000;
const REFRESH_EVENT = "stockstream:refresh-balances";

export interface WalletBalances {
  solLamports: bigint | null;
  collateralTokenBalance: bigint | null;
}

/** Ask every balance view to re-read now (after a deposit, withdraw, faucet…). */
export function refreshWalletBalances() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

/** Live wallet balances: websocket `accountSubscribe` on the wallet and its
 * USDC account pushes changes as they are processed; a slow poll covers a
 * dropped socket, and `refreshWalletBalances()` forces an immediate read. */
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
    window.addEventListener(REFRESH_EVENT, poll);
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(rpc.endpoint.replace(/^http/, "ws"));
      const keys = [walletAddress, collateralTokenAccount].filter((key): key is string => !!key);
      socket.onopen = () => keys.forEach((key, index) => socket?.send(JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "accountSubscribe", params: [key, { encoding: "base64", commitment: "processed" }] })));
      socket.onmessage = (event) => { if (String(event.data).includes("accountNotification")) poll(); };
    } catch { /* polling still covers it */ }
    return () => { stopped = true; clearInterval(interval); window.removeEventListener(REFRESH_EVENT, poll); socket?.close(); };
  }, [rpc, walletAddress, collateralTokenAccount]);

  return balances;
}
