/** Minimal external store (useSyncExternalStore) for the diagnostics
 * page's "last transaction signature" -- every real submission path
 * (deposit, withdraw, session authorize/revoke, session-signed orders)
 * records here so Diagnostics doesn't need its own duplicate tracking in
 * every hook. Session-only; not persisted. */
export interface LastSignatureRecord {
  instruction: string;
  signature: string;
  domain: "l1" | "er";
  at: number;
}

let record: LastSignatureRecord | null = null;
const listeners = new Set<() => void>();

export function recordSignature(instruction: string, signature: string, domain: "l1" | "er" = "l1"): void {
  record = { instruction, signature, domain, at: Date.now() };
  for (const listener of listeners) listener();
}

export function subscribeLastSignature(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLastSignature(): LastSignatureRecord | null {
  return record;
}
