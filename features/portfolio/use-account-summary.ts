"use client";

import { useEffect, useMemo, useState } from "react";
import { useWalletBalances } from "./use-wallet-balances";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { deriveV3ExecutionAccounts } from "@/clients/equinox/src";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";
import { loadTradingKey } from "@/lib/trading-key";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { SolanaRpcTransport } from "@/lib/rpc-transport";
import deployment from "@/config/equinox-deployment.json";
import { decodeV3SeatShard } from "../../workers/src/v3-market-state";

const L1_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SEAT_POLL_MS = 5_000;
export const ACCOUNT_MARKET = "TSLA-PERP";

export interface AccountSeat {
  index: number;
  available: bigint;
  reserved: bigint;
  position: bigint;
  realizedPnl: bigint;
  openOrderCount: number;
}

/** The wallet's seat in the live v3 market, read from whichever chain holds
 * it (the MagicBlock rollup while delegated, Solana L1 otherwise).
 * seat: undefined = not read yet, null = no seat. `unavailable` is set
 * while the last read failed, so callers can say so instead of spinning. */
export function useSeat(wallet: string | null, delegated: boolean, enabled: boolean): { seat: AccountSeat | null | undefined; unavailable: boolean } {
  const [seat, setSeat] = useState<AccountSeat | null | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!wallet || !enabled || !deployment.core) return;
    let stopped = false;
    const shards = deriveV3ExecutionAccounts(deployment.core, deployment.core).seatShards.map(String);
    const load = async () => {
      const response = await fetch(delegated ? deployment.magicBlock.rpc : L1_RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [shards, { encoding: "base64", commitment: "confirmed" }] }),
      }).then((r) => r.json()).catch(() => null) as { result?: { value: ({ data: [string] } | null)[] } } | null;
      if (stopped) return;
      setUnavailable(!response?.result);
      if (!response?.result) return;
      const positions = response.result.value.flatMap((account) => (account ? decodeV3SeatShard(Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0)))?.positions ?? [] : []));
      const own = positions.find((p) => p.trader === wallet);
      setSeat(own ? {
        index: own.shard * 32 + own.slot,
        available: own.availableCollateral,
        reserved: own.reservedMargin,
        position: own.basePosition,
        realizedPnl: own.realizedPnl,
        openOrderCount: own.openOrderCount,
      } : null);
    };
    void load();
    const timer = setInterval(() => void load(), SEAT_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [wallet, delegated, enabled]);
  return wallet && enabled ? { seat, unavailable } : { seat: undefined, unavailable: false };
}

export interface AccountSummary {
  wallet: { address: string; sol: bigint | null; usdc: bigint | null } | null;
  trading: { address: string; sol: bigint | null; usdc: bigint | null } | null;
  seat: AccountSeat | null | undefined;
  /** The last seat read failed (RPC down); `seat` may be stale or undefined. */
  seatUnavailable: boolean;
  delegated: boolean;
  /** null while the market's execution status has not been read. */
  execution: ReturnType<typeof useExecutionStatus>;
  /** Wallet + trading account + vault seat, in 6-decimal units; null until the wallet's USDC is read. */
  totalUsdc: bigint | null;
}

/** One read of everything the connected account holds -- shared by the top
 * bar pill, the wallet drawer and the Portfolio page so they always agree. */
export function useAccountSummary(walletAddress: string | null, enabled = true): AccountSummary {
  const rpc = useMemo(() => new SolanaRpcTransport(L1_RPC), []);
  const active = enabled && !!walletAddress;
  const ata = useMemo(() => (walletAddress && deployment.collateralMint ? String(deriveCollateralTokenAccount(walletAddress, deployment.collateralMint, TOKEN_PROGRAM)) : null), [walletAddress]);
  const walletBalances = useWalletBalances(active ? rpc : null, walletAddress, ata);
  // The in-app trading key (lib/trading-key.ts) holds the seat once unlocked on the Trade page.
  const [trading, setTrading] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setTrading(walletAddress && active ? loadTradingKey(walletAddress)?.publicKey.toBase58() ?? null : null);
    read();
    // The key appears in storage the moment it is unlocked (any tab).
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    return () => { window.removeEventListener("storage", read); window.removeEventListener("focus", read); };
  }, [walletAddress, active]);
  const tradingAta = useMemo(() => (trading && deployment.collateralMint ? String(deriveCollateralTokenAccount(trading, deployment.collateralMint, TOKEN_PROGRAM)) : null), [trading]);
  const tradingBalances = useWalletBalances(active && trading ? rpc : null, trading, tradingAta);
  const execution = useExecutionStatus(active ? publicMarketApiUrl : undefined, ACCOUNT_MARKET);
  const delegated = execution?.marketDelegated ?? false;
  const { seat, unavailable: seatUnavailable } = useSeat(trading ?? walletAddress, delegated, active);

  const totalUsdc = walletBalances.collateralTokenBalance === null
    ? null
    : walletBalances.collateralTokenBalance
      + (trading ? tradingBalances.collateralTokenBalance ?? 0n : 0n)
      + (seat ? seat.available + seat.reserved : 0n);

  return {
    wallet: walletAddress ? { address: walletAddress, sol: walletBalances.solLamports, usdc: walletBalances.collateralTokenBalance } : null,
    trading: trading ? { address: trading, sol: tradingBalances.solLamports, usdc: tradingBalances.collateralTokenBalance } : null,
    seat,
    seatUnavailable,
    delegated,
    execution,
    totalUsdc,
  };
}
