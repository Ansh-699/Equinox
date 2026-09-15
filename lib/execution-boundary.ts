export type TransactionStatus = "constructed" | "simulated" | "awaiting_signature" | "submitted" | "er_accepted" | "l1_committed" | "blocked_runtime" | "blocked_credential";
export interface TransactionPreview { instruction: string; programId: string; accounts: readonly { address: string; signer: boolean; writable: boolean }[]; feeLamports?: bigint; status: TransactionStatus; clientOrderId?: string; }
export interface WalletBoundary { signTransaction(bytes: Uint8Array): Promise<Uint8Array>; }
export interface RouterBoundary { getAccountAwareBlockhash(writableAccounts: readonly string[]): Promise<string>; submit(serialized: Uint8Array): Promise<{ status: "er_accepted"; sequence: bigint }>; }
export function requireClientOrderId(id: string): string { if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("invalid client order id"); return id; }
export async function signL1(preview: TransactionPreview, wallet: WalletBoundary, bytes: Uint8Array): Promise<{ preview: TransactionPreview; bytes: Uint8Array }> {
  return { preview: { ...preview, status: "awaiting_signature" }, bytes: await wallet.signTransaction(bytes) };
}
export async function submitEr(preview: TransactionPreview, router: RouterBoundary, bytes: Uint8Array): Promise<{ preview: TransactionPreview; sequence: bigint }> {
  const result = await router.submit(bytes);
  return { preview: { ...preview, status: result.status }, sequence: result.sequence };
}
