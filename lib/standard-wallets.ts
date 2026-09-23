"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

/** A Solana wallet discovered through the Wallet Standard (Phantom, Solflare, Backpack, …). */
export interface SolanaWalletOption { name: string; icon: string; wallet: Wallet }

type Feature<T> = T | undefined;
interface ConnectFeature { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> }
interface DisconnectFeature { disconnect(): Promise<void> }
interface SignMessageFeature { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array }[]> }
interface SignTransactionFeature { signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]> }

const feature = <T>(wallet: Wallet, name: string) => (wallet.features as Record<string, unknown>)[name] as Feature<T>;
const isSolana = (wallet: Wallet) => wallet.chains.some((chain) => chain.startsWith("solana:")) && !!feature(wallet, "standard:connect") && !!feature(wallet, "solana:signTransaction");

/** Installed Solana wallets, deduplicated by name. */
export function listSolanaWallets(): SolanaWalletOption[] {
  if (typeof window === "undefined") return [];
  const seen = new Set<string>();
  return getWallets().get().filter(isSolana).filter((wallet) => !seen.has(wallet.name) && seen.add(wallet.name)).map((wallet) => ({ name: wallet.name, icon: wallet.icon, wallet }));
}

/** Calls `listener` whenever a wallet extension registers or unregisters. */
export function onWalletsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const api = getWallets();
  const off = [api.on("register", listener), api.on("unregister", listener)];
  return () => off.forEach((dispose) => dispose());
}

/** `silent` reconnects only if the wallet already trusts this site (no popup). */
export async function connectWallet(wallet: Wallet, silent = false): Promise<WalletAccount> {
  const { accounts } = await feature<ConnectFeature>(wallet, "standard:connect")!.connect(silent ? { silent: true } : undefined);
  const account = accounts.find((candidate) => candidate.chains.some((chain) => chain.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account`);
  return account;
}

export async function signMessageWith(wallet: Wallet, account: WalletAccount, message: Uint8Array): Promise<Uint8Array> {
  const [result] = await feature<SignMessageFeature>(wallet, "solana:signMessage")!.signMessage({ account, message });
  return result.signature;
}

export async function signTransactionWith(wallet: Wallet, account: WalletAccount, transaction: Uint8Array): Promise<Uint8Array> {
  const [result] = await feature<SignTransactionFeature>(wallet, "solana:signTransaction")!.signTransaction({ account, transaction, chain: "solana:devnet" });
  return result.signedTransaction;
}

export async function disconnectWallet(wallet: Wallet): Promise<void> {
  await feature<DisconnectFeature>(wallet, "standard:disconnect")?.disconnect().catch(() => undefined);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// A cached snapshot for useSyncExternalStore: recomputed only on register events.
const NO_WALLETS: SolanaWalletOption[] = [];
let snapshot: SolanaWalletOption[] | null = null;
export function subscribeSolanaWallets(listener: () => void): () => void {
  return onWalletsChanged(() => { snapshot = listSolanaWallets(); listener(); });
}
export function getSolanaWalletsSnapshot(): SolanaWalletOption[] {
  snapshot ??= listSolanaWallets();
  return snapshot;
}
export const getServerSolanaWalletsSnapshot = () => NO_WALLETS;

const REMEMBERED = "stockstream:wallet";
/** The wallet the user last picked, for a silent reconnect on the next visit. */
export function rememberedWallet(): string | null {
  try { return localStorage.getItem(REMEMBERED); } catch { return null; }
}
export function rememberWallet(name: string | null) {
  try { if (name) localStorage.setItem(REMEMBERED, name); else localStorage.removeItem(REMEMBERED); } catch { /* storage blocked */ }
}
