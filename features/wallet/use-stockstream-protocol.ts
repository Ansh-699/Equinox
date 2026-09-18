"use client";

import { useMemo } from "react";
import { useActiveWalletSigner } from "@/components/wallet-signer-context";
import { MagicRouterTransport, SolanaRpcTransport } from "@/lib/rpc-transport";
import { StockStreamProtocolService } from "@/lib/protocol-service";
import { encodeTransaction } from "@/lib/solana-transaction";

const DEVNET_PUBLIC_RPC = "https://api.devnet.solana.com";
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? DEVNET_PUBLIC_RPC;

export interface StockStreamProtocol {
  walletAddress: string;
  rpc: SolanaRpcTransport;
  service: StockStreamProtocolService;
}

/** Binds the active main wallet's signer (real Privy, test-mode fake, or
 * "no signer available" -- see components/wallet-signer-context.tsx) to
 * the real L1/ER transports. Null until a wallet and market are known.
 * Deliberately never calls @privy-io/react-auth/solana's hooks directly:
 * they throw when rendered without a PrivyProvider ancestor, which used
 * to crash the whole trading terminal whenever Privy was unconfigured. */
export function useStockStreamProtocol(marketAddress: string | null): StockStreamProtocol | null {
  const signer = useActiveWalletSigner();

  return useMemo(() => {
    if (!signer.address || !marketAddress) return null;
    const walletAddress = signer.address;
    const rpc = new SolanaRpcTransport(RPC_URL);
    const er = new MagicRouterTransport(rpc, marketAddress);
    const encode = async (instructions: Parameters<typeof encodeTransaction>[1], blockhash?: string) => {
      const resolvedBlockhash = blockhash ?? (await rpc.latestBlockhash()).blockhash;
      return encodeTransaction(walletAddress, instructions, resolvedBlockhash);
    };
    return { walletAddress, rpc, service: new StockStreamProtocolService({ encode, wallet: signer, l1: rpc, er }) };
  }, [signer, marketAddress]);
}
