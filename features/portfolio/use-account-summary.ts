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
import { V3_MARKETS } from "@/lib/v3-markets";
import { decodeV3SeatShard } from "../../workers/src/v3-market-state";

const L1_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet";
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

/** One market's seat, by market symbol. */
export type MarketSeats = Record<string, AccountSeat | null>;
const SEAT_SHARDS = V3_MARKETS.map((m) => ({ symbol: m.symbol, keys: deriveV3ExecutionAccounts(m.core, m.core).seatShards.map(String) }));

/** The wallet's seat in every market, read in one call from whichever chain
 * holds them (the MagicBlock rollup while delegated, Solana L1 otherwise).
 * seats: undefined = not read yet; a market maps to null when there is no
 * seat. `unavailable` is set while the last read failed. */
export function useSeats(wallet: string | null, delegated: boolean, enabled: boolean): { seats: MarketSeats | undefined; unavailable: boolean } {
  const [snapshot, setSnapshot] = useState<{ wallet: string; delegated: boolean; seats: MarketSeats } | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; delegated: boolean } | null>(null);
  useEffect(() => {
    if (!wallet || !enabled) return;
    let stopped = false;
    const keys = SEAT_SHARDS.flatMap((m) => m.keys);
    const load = async () => {
      const response = await fetch(delegated ? deployment.magicBlock.rpc : L1_RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64", commitment: "confirmed" }] }),
      }).then((r) => r.json()).catch(() => null) as { result?: { value: ({ data: [string] } | null)[] } } | null;
      if (stopped) return;
      const values = response?.result?.value;
      if (!values || values.length !== keys.length) { setFailure({ wallet, delegated }); return; }
      setFailure(null);
      setSnapshot({ wallet, delegated, seats: Object.fromEntries(SEAT_SHARDS.map((market, m) => {
        const positions = values.slice(m * 4, m * 4 + 4).flatMap((account) => (account ? decodeV3SeatShard(Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0)))?.positions ?? [] : []));
        const own = positions.find((p) => p.trader === wallet);
        return [market.symbol, own ? {
          index: own.shard * 32 + own.slot,
          available: own.availableCollateral,
          reserved: own.reservedMargin,
          position: own.basePosition,
          realizedPnl: own.realizedPnl,
          openOrderCount: own.openOrderCount,
        } : null];
      })) });
    };
    void load();
    const timer = setInterval(() => void load(), SEAT_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [wallet, delegated, enabled]);
  return wallet && enabled
    ? { seats: snapshot?.wallet === wallet && snapshot.delegated === delegated ? snapshot.seats : undefined, unavailable: failure?.wallet === wallet && failure.delegated === delegated }
    : { seats: undefined, unavailable: false };
}

export interface AccountSummary {
  wallet: { address: string; sol: bigint | null; usdc: bigint | null } | null;
  trading: { address: string; sol: bigint | null; usdc: bigint | null } | null;
  /** TSLA-PERP's seat (the terminal's default market); `seats` has every market. */
  seat: AccountSeat | null | undefined;
  seats: MarketSeats | undefined;
  /** The last seat read failed (RPC down); `seat` may be stale or undefined. */
  seatUnavailable: boolean;
  delegated: boolean;
  /** null while the market's execution status has not been read. */
  execution: ReturnType<typeof useExecutionStatus>;
  /** Wallet + trading account + every market seat, in 6-decimal units; null until the wallet is read. */
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
  // Every market in the manifest is delegated: read the rollup until the
  // status says otherwise (L1's frozen copy has no seats, so the page flashed
  // "no position" on every load).
  const delegated = execution ? execution.marketDelegated : true;
  const { seats, unavailable: seatUnavailable } = useSeats(trading ?? walletAddress, delegated, active);
  const seat = seats === undefined ? undefined : seats[ACCOUNT_MARKET] ?? null;

  // A wallet with no USDC account yet (the trading key holds the funds) reads
  // as missing, not zero: count it as zero once the wallet itself has been read.
  const totalUsdc = walletBalances.solLamports === null || seats === undefined || (trading && tradingBalances.solLamports === null)
    ? null
    : (walletBalances.collateralTokenBalance ?? 0n)
      + (trading ? tradingBalances.collateralTokenBalance ?? 0n : 0n)
      + Object.values(seats ?? {}).reduce((sum, s) => sum + (s ? s.available + s.reserved : 0n), 0n);

  return {
    wallet: walletAddress ? { address: walletAddress, sol: walletBalances.solLamports, usdc: walletBalances.collateralTokenBalance } : null,
    trading: trading ? { address: trading, sol: tradingBalances.solLamports, usdc: tradingBalances.collateralTokenBalance } : null,
    seat,
    seats,
    seatUnavailable,
    delegated,
    execution,
    totalUsdc,
  };
}
