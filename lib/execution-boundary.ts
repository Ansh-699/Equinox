export type TransactionStatus = "constructed" | "simulated" | "awaiting_signature" | "submitted" | "er_accepted" | "l1_committed" | "l1_finalized" | "blocked_runtime" | "blocked_credential";
export interface TransactionPreview { instruction: string; programId: string; accounts: readonly { address: string; signer: boolean; writable: boolean }[]; feeLamports?: bigint; status: TransactionStatus; clientOrderId?: string; }
export interface WalletBoundary { signTransaction(bytes: Uint8Array): Promise<Uint8Array>; }
export interface RouterBoundary { getAccountAwareBlockhash(writableAccounts: readonly string[]): Promise<string>; submit(serialized: Uint8Array, kind?: string): Promise<{ status: "er_accepted"; sequence: bigint; signature?: string }>; warm?(writableAccounts: readonly string[]): void; }
export interface L1Transport { simulate(bytes: Uint8Array): Promise<{ units: number }>; submit(bytes: Uint8Array): Promise<{ signature: string }>; confirm(signature: string): Promise<"confirmed" | "finalized">; }
export function requireClientOrderId(id: string): string { if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("invalid client order id"); return id; }
export async function signL1(preview: TransactionPreview, wallet: WalletBoundary, bytes: Uint8Array): Promise<{ preview: TransactionPreview; bytes: Uint8Array }> {
  return { preview: { ...preview, status: "awaiting_signature" }, bytes: await wallet.signTransaction(bytes) };
}
export async function submitEr(preview: TransactionPreview, router: RouterBoundary, bytes: Uint8Array): Promise<{ preview: TransactionPreview; sequence: bigint; signature?: string }> {
  const result = await router.submit(bytes, preview.instruction);
  return { preview: { ...preview, status: result.status }, sequence: result.sequence, signature: result.signature };
}
/** `ensureFreshOracle` runs before simulation and again after signing: a
 * wallet prompt can outlast the program's 10-second oracle freshness window. */
export async function executeL1(preview: TransactionPreview, wallet: WalletBoundary, transport: L1Transport, bytes: Uint8Array, ensureFreshOracle?: () => Promise<void>): Promise<{ preview: TransactionPreview; signature: string; confirmation: "confirmed" | "finalized" }> {
  await ensureFreshOracle?.();
  await transport.simulate(bytes);
  const signed = await signL1(preview, wallet, bytes);
  await ensureFreshOracle?.();
  const submitted = await transport.submit(signed.bytes);
  const confirmation = await transport.confirm(submitted.signature);
  return { preview: { ...signed.preview, status: confirmation === 'finalized' ? 'l1_finalized' : 'l1_committed' }, signature: submitted.signature, confirmation };
}
