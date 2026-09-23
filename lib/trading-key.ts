"use client";

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createKeyPairFromPrivateKeyBytes, signBytes } from "@solana/kit";
import type { ActiveWalletSigner } from "@/components/wallet-signer-context";

/**
 * The in-app trading key: the same role a Privy embedded wallet plays. It is
 * derived from ONE signature of a fixed, domain-bound message by the user's
 * wallet (ed25519 signatures are deterministic, so the same wallet always
 * gets the same key, on any device) and then signs seats, deposits, orders
 * and withdrawals silently -- no wallet popup per action.
 * ponytail: devnet-grade custody (the key sits in localStorage); a real
 * deployment would use Privy embedded wallets or scoped session keys.
 */
export const tradingKeyMessage = (wallet: string) =>
  `StockStream trading key v1\n\nSign to unlock your in-app trading account on stockstream (Solana devnet).\nOnly sign this on the StockStream site.\n\nWallet: ${wallet}`;

const storageKey = (wallet: string) => `stockstream:trading-key:${wallet}`;

export async function tradingKeyFromSignature(signature: Uint8Array): Promise<Keypair> {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", signature.slice()));
  return Keypair.fromSeed(seed);
}

export function loadTradingKey(wallet: string): Keypair | null {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])) : null;
  } catch { return null; }
}

export function saveTradingKey(wallet: string, key: Keypair) {
  try { localStorage.setItem(storageKey(wallet), JSON.stringify(Array.from(key.secretKey))); } catch { /* derived again next time */ }
}

export function forgetTradingKey(wallet: string) {
  try { localStorage.removeItem(storageKey(wallet)); } catch { /* nothing stored */ }
}

export function tradingKeySigner(key: Keypair): ActiveWalletSigner & { signMessage(bytes: Uint8Array): Promise<Uint8Array> } {
  return {
    address: key.publicKey.toBase58(),
    signTransaction: async (bytes) => {
      const transaction = VersionedTransaction.deserialize(bytes);
      transaction.sign([key]);
      return transaction.serialize();
    },
    signMessage: async (bytes) => {
      const pair = await createKeyPairFromPrivateKeyBytes(key.secretKey.slice(0, 32));
      return new Uint8Array(await signBytes(pair.privateKey, bytes));
    },
  };
}
