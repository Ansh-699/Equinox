"use client";

import { useMemo } from "react";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { PrivyWalletSigner } from "@/lib/privy-signing";
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

/** Binds the active Privy Solana wallet to the real L1/ER transports. Null until a wallet and market are known. */
export function useStockStreamProtocol(marketAddress: string | null): StockStreamProtocol | null {
  const { signTransaction } = useSignTransaction();
  const { wallets } = useWallets();
  const wallet = wallets[0];

  return useMemo(() => {
    if (!wallet || !marketAddress) return null;
    const rpc = new SolanaRpcTransport(RPC_URL);
    const er = new MagicRouterTransport(rpc, marketAddress);
    const walletBoundary = new PrivyWalletSigner(signTransaction, wallet, "solana:devnet");
    const encode = async (instructions: Parameters<typeof encodeTransaction>[1], blockhash?: string) => {
      const resolvedBlockhash = blockhash ?? (await rpc.latestBlockhash()).blockhash;
      return encodeTransaction(wallet.address, instructions, resolvedBlockhash);
    };
    return { walletAddress: wallet.address, rpc, service: new StockStreamProtocolService({ encode, wallet: walletBoundary, l1: rpc, er }) };
  }, [wallet, marketAddress, signTransaction]);
}
