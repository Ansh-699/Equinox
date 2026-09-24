export const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
export const UNDELEGATE_CALLBACK = [196, 28, 41, 206, 48, 37, 51, 167] as const;
/**
 * Delegation-time automatic commit frequency, in milliseconds. This value is
 * encoded into the `Delegate` instruction's `commit_frequency_ms` field
 * (see `programs/equinox/src/magicblock.rs::encode_delegate_instruction_data`),
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

/**
 * Account-domain matrix: which writable Equinox accounts each trading
 * instruction writes, verified against `programs/equinox/src/handlers.rs`
 * (and `docs/magicblock.md`'s account-domain matrix). All of these are ER
 * execution-domain accounts: while the market is delegated, every one of them
 * must be delegated to the SAME ER validator, or the ER runtime rejects the
 * transaction ("mixed delegated and undelegated writable accounts").
 *
 * - placeOrder / replaceOrder / reduce-only close: market + the placing
 *   seat's settlement scratch + the trading session (when session-signed).
 * - cancelOrder / cancelAll: market + the trading session (session-signed);
 *   they do NOT touch scratch.
 * - funding / liquidation / expiry cleanup: market only (cleanup runs inside
 *   the matching path, which uses the placing seat's scratch).
 * - consumeOracleUpdate: L1-only (it writes the Pyth program's own
 *   storage/treasury accounts, which can never enter the ER domain) -- while
 *   delegated, live prices must flow through a separately delegated
 *   ephemeral-oracle feed read instead (docs/oracle.md).
 * - deposit / withdraw: L1-only (vaults are never delegated).
 */
export type TradingInstruction =
  | "placeOrder"
  | "replaceOrder"
  | "cancelOrder"
  | "cancelAll"
  | "funding"
  | "liquidation"
  | "reduceOnlyClose"
  | "oracleUpdate"
  | "deposit"
  | "withdraw";

export const ER_WRITABLE_CLUSTERS: Record<TradingInstruction, readonly string[]> = {
  placeOrder: ["market", "settlementScratch", "tradingSession"],
  replaceOrder: ["market", "settlementScratch", "tradingSession"],
  reduceOnlyClose: ["market", "settlementScratch", "tradingSession"],
  cancelOrder: ["market", "tradingSession"],
  cancelAll: ["market", "tradingSession"],
  funding: ["market"],
  liquidation: ["market"],
  oracleUpdate: [],
  deposit: [],
  withdraw: [],
};

/**
 * Rejects an invalid writable-account cluster for one instruction BEFORE
 * submission: every writable account in the transaction must be a member of
 * the delegated hot cluster for that instruction, all in the ER domain, with
 * no duplicates. `accounts` is every writable account the transaction would
 * write; `cluster` maps role names (from `ER_WRITABLE_CLUSTERS`) to the
 * delegated addresses currently available in the ER domain.
 */
export function validateTransactionAccountDomain(
  instructionName: TradingInstruction,
  accounts: WritableAccount[],
  cluster: Record<string, string[]>,
): void {
  const required = ER_WRITABLE_CLUSTERS[instructionName];
  const delegatedSet = new Set<string>();
  for (const role of Object.keys(cluster)) {
    if (!ER_WRITABLE_CLUSTERS[instructionName].includes(role)) continue;
    for (const address of cluster[role]) {
      if (delegatedSet.has(address)) throw new Error("duplicate delegated account");
      delegatedSet.add(address);
    }
  }
  const seen = new Set<string>();
  for (const account of accounts) {
    if (!account.writable) continue;
    if (seen.has(account.address)) throw new Error("duplicate writable account");
    seen.add(account.address);
    if (!delegatedSet.has(account.address)) {
      throw new Error(`writable account ${account.address} is outside the delegated ER domain for ${instructionName}`);
    }
  }
  for (const address of delegatedSet) {
    if (!seen.has(address)) {
      throw new Error(`delegated account ${address} is not writable in the ${instructionName} transaction`);
    }
  }
}
export function encodeCommit(sequence: bigint, undelegate = false): Uint8Array {
  const out = new Uint8Array(10); out[0] = undelegate ? 2 : 1; out[1] = 0;
  new DataView(out.buffer).setBigUint64(2, sequence, true); return out;
}
export function validateCallback(data: Uint8Array): boolean { return data.length >= 8 && UNDELEGATE_CALLBACK.every((v, i) => data[i] === v); }
