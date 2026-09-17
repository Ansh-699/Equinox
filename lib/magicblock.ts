export const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
export const UNDELEGATE_CALLBACK = [196, 28, 41, 206, 48, 37, 51, 167] as const;
/**
 * Delegation-time automatic commit frequency, in milliseconds. This value is
 * encoded into the `Delegate` instruction's `commit_frequency_ms` field
 * (see `programs/stockstream/src/magicblock.rs::encode_delegate_instruction_data`),
 * so the delegation program auto-commits the market on this cadence for as long
 * as it stays delegated. It is NOT a keeper scheduling knob: the Worker commit
 * keeper's own minimum tick interval is separate
 * (`workers/src/keeper-jobs.ts::MIN_COMMIT_TICK_MS`). Per-market commit policy
 * requires a program-side delegation-argument and header-field change (see
 * `docs/magicblock.md` § Commit policy), not a Worker setting.
 */
export const DELEGATION_COMMIT_FREQUENCY_MS = 30_000;
export type AccountDomain = "l1" | "er";
export interface WritableAccount { address: string; domain: AccountDomain; writable: boolean; }
export function validateHotCluster(accounts: WritableAccount[]): void {
  if (!accounts.length || accounts.some((a) => !a.writable || a.domain !== "er")) throw new Error("delegated hot account cluster is incomplete");
  if (new Set(accounts.map((a) => a.address)).size !== accounts.length) throw new Error("duplicate delegated account");
}
export function rejectMixedWritableDomains(accounts: WritableAccount[]): void {
  const domains = new Set(accounts.filter((a) => a.writable).map((a) => a.domain));
  if (domains.size > 1) throw new Error("mixed delegated and L1 writable accounts");
}
export function encodeCommit(sequence: bigint, undelegate = false): Uint8Array {
  const out = new Uint8Array(10); out[0] = undelegate ? 2 : 1; out[1] = 0;
  new DataView(out.buffer).setBigUint64(2, sequence, true); return out;
}
export function validateCallback(data: Uint8Array): boolean { return data.length >= 8 && UNDELEGATE_CALLBACK.every((v, i) => data[i] === v); }
