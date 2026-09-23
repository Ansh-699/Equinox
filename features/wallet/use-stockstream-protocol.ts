"use client";

import { useMemo } from "react";
import { AddressLookupTableAccount, PublicKey } from "@solana/web3.js";
import { DEMO_LOOKUP_TABLE, DEMO_ORACLE_SNAPSHOT, publicMarketApiUrl, publicV3Core } from "@/lib/demo-config";
import { createOracleFreshness } from "@/lib/oracle-freshness";
import { decodeOracleSnapshotV3, deriveV3ExecutionAccounts } from "@/clients/stockstream/src";
import deployment from "@/config/stockstream-deployment.json";
import { useActiveWalletSigner, type ActiveWalletSigner } from "@/components/wallet-signer-context";
import { MagicRouterTransport, SolanaRpcTransport } from "@/lib/rpc-transport";
import { StockStreamProtocolService } from "@/lib/protocol-service";
import { ErSocket } from "@/lib/er-socket";

let sharedSocket: ErSocket | null = null;
/** One rollup websocket per tab, shared by every protocol instance. */
const rollupSocket = () => (sharedSocket ??= new ErSocket(deployment.magicBlock.rpc));
import { encodeTransaction } from "@/lib/solana-transaction";

const DEVNET_PUBLIC_RPC = "https://api.devnet.solana.com";
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? DEVNET_PUBLIC_RPC;

export interface StockStreamProtocol {
  walletAddress: string;
  rpc: SolanaRpcTransport;
  /** Magic Router: delegation status and ER-routed submission. */
  router: SolanaRpcTransport;
  service: StockStreamProtocolService;
}

/** Binds the active main wallet's signer (real Privy, test-mode fake, or
 * "no signer available" -- see components/wallet-signer-context.tsx) to
 * the real L1/ER transports. Null until a wallet and market are known.
 * Deliberately never calls @privy-io/react-auth/solana's hooks directly:
 * they throw when rendered without a PrivyProvider ancestor, which used
 * to crash the whole trading terminal whenever Privy was unconfigured. */
export function useStockStreamProtocol(marketAddress: string | null, override?: ActiveWalletSigner | null): StockStreamProtocol | null {
  const walletSigner = useActiveWalletSigner();
  const signer = override ?? walletSigner;

  return useMemo(() => {
    if (!signer.address || !marketAddress) return null;
    const walletAddress = signer.address;
    const rpc = new SolanaRpcTransport(RPC_URL);
    // Delegation status, ER blockhashes and routed submission come from the Magic Router.
    // The rollup confirms in one round trip: poll every 50 ms, not the L1 500 ms.
    const router = new SolanaRpcTransport(deployment.magicBlock.router, fetch.bind(globalThis), () => new Promise((resolve) => setTimeout(resolve, 50)), 120);
    // Transactions for the rollup go straight to it (Singapore), confirmed by websocket push.
    const erRpc = new SolanaRpcTransport(deployment.magicBlock.rpc, fetch.bind(globalThis), () => new Promise((resolve) => setTimeout(resolve, 50)), 120);
    const er = new MagicRouterTransport(router, marketAddress, { validator: deployment.magicBlock.validator, rpc: erRpc, socket: rollupSocket() });
    // Warm the per-account delegation check and the blockhash so the first order pays no setup round trips.
    if (publicV3Core) {
      const bundle = deriveV3ExecutionAccounts(publicV3Core, walletAddress);
      void er.getAccountAwareBlockhash([bundle.core, ...bundle.bookPages, ...bundle.seatShards, ...bundle.eventShards].map(String)).catch(() => undefined);
    }
    let lookupTable: Promise<AddressLookupTableAccount[]> | undefined;
    const marketLookupTables = () => lookupTable ??= DEMO_LOOKUP_TABLE
      // Owned by the address-lookup-table program, so read it without the StockStream owner check.
      ? rpc.rawAccountBytes(DEMO_LOOKUP_TABLE).then((bytes) => (bytes ? [new AddressLookupTableAccount({
        key: new PublicKey(DEMO_LOOKUP_TABLE), state: AddressLookupTableAccount.deserialize(bytes),
      })] : []))
      : Promise.resolve([]);
    // L1 transactions (no ER blockhash) compile through the market lookup table so
    // 33-account custody instructions fit; ER transactions stay table-free.
    const encode = async (instructions: Parameters<typeof encodeTransaction>[1], blockhash?: string) => {
      if (blockhash) return encodeTransaction(walletAddress, instructions, blockhash);
      const [latest, tables] = await Promise.all([rpc.latestBlockhash(), marketLookupTables()]);
      return encodeTransaction(walletAddress, instructions, latest.blockhash, tables);
    };
    const freshOracle = DEMO_ORACLE_SNAPSHOT && publicMarketApiUrl
      ? createOracleFreshness({ marketApiUrl: publicMarketApiUrl, readErSequence: async () => decodeOracleSnapshotV3(await erRpc.accountBytes(DEMO_ORACLE_SNAPSHOT)).sequence, readErPublishTime: async () => decodeOracleSnapshotV3(await erRpc.accountBytes(DEMO_ORACLE_SNAPSHOT)).publishTimestamp })
      : undefined;
    return { walletAddress, rpc, router, service: new StockStreamProtocolService({ encode, wallet: signer, l1: rpc, er, freshOracle }) };
  }, [signer, marketAddress]);
}
