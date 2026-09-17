/** Concrete JSON-RPC adapters used by the indexer and, as of Priority 8, the
 * keeper transaction-submission path. They deliberately return raw RPC
 * values: decoding StockStream account/event bytes remains a protocol
 * concern in the indexer/reconciliation layer, not a trust decision made by
 * a transport. */
import { retryDelay } from './backoff';

export type RpcFetch = typeof fetch;

export class JsonRpcTransport {
  constructor(private readonly endpoint: string, private readonly request: RpcFetch = fetch) {
    if (!endpoint.startsWith('https://') && !endpoint.startsWith('http://')) throw new Error('Invalid RPC endpoint');
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.request(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json() as { result?: T; error?: { message?: string; code?: number } };
    if (body.error) throw new Error(`RPC error${body.error.code !== undefined ? ` ${body.error.code}` : ''}: ${body.error.message ?? 'unknown'}`);
    if (body.result === undefined) throw new Error('RPC response missing result');
    return body.result;
  }
}

export interface AccountInfoResult {
  context: { slot: number };
  value: { data: [string, string] | null; owner: string; lamports: number } | null;
}

export interface MultipleAccountsResult {
  context: { slot: number };
  value: Array<{ data: [string, string] | null; owner: string; lamports: number } | null>;
}

export interface BlockhashResult {
  context: { slot: number };
  value: { blockhash: string; lastValidBlockHeight: number };
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

export interface SignatureStatusesResult {
  context: { slot: number };
  value: Array<SignatureStatus | null>;
}

export interface SimulateTransactionResult {
  context: { slot: number };
  value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
}

export interface SendTransactionOptions {
  skipPreflight?: boolean;
  preflightCommitment?: 'processed' | 'confirmed' | 'finalized';
  maxRetries?: number;
}

/** Classifies a transport-layer error (thrown by `JsonRpcTransport.call`,
 * or a `fetch` rejection) as safe to retry, permanently rejected, or
 * unclassifiable. A keeper should only ever automatically retry
 * `"retryable"` failures on read/simulate operations -- never
 * `sendTransaction` blindly, since a lost response doesn't mean the
 * transaction wasn't actually accepted (that's what confirmation polling
 * plus the keeper's own idempotency key is for). */
export type RpcErrorClass = 'retryable' | 'permanent' | 'unknown';

const RETRYABLE_PATTERNS = [
  /blockhash not found/i,
  /rate limit/i,
  /429/,
  /too many requests/i,
  /timed? ?out/i,
  /network/i,
  /fetch failed/i,
  /node is behind/i,
  /-32005/, // JSON-RPC "node is unhealthy"
  /RPC HTTP 5\d\d/,
  /RPC HTTP 429/,
];
const PERMANENT_PATTERNS = [
  /insufficient (lamports|funds)/i,
  /invalid signature/i,
  /instructionerror/i,
  /custom program error/i,
  /already (been )?processed/i,
  /accountnotfound/i,
  /invalid.*blockhash/i,
  /RPC HTTP 4(0[0-24-9]|[1-9]\d)/, // any 4xx other than 429
];

export function classifyRpcError(error: unknown): RpcErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  if (RETRYABLE_PATTERNS.some((p) => p.test(message))) return 'retryable';
  if (PERMANENT_PATTERNS.some((p) => p.test(message))) return 'permanent';
  return 'unknown';
}

/** Bounded retry for safe (idempotent, read-only or simulate-only)
 * operations, using `backoff.ts`'s shared exponential-delay schedule.
 * Retries only `"retryable"`-classified failures; anything else (or
 * exhausting `maxAttempts`) rethrows immediately. */
export async function withRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || classifyRpcError(error) !== 'retryable') throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }
  throw lastError;
}

export interface ConfirmOptions {
  targetCommitment: 'confirmed' | 'finalized';
  lastValidBlockHeight: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type ConfirmationOutcome =
  | { status: 'confirmed' | 'finalized' }
  | { status: 'failed'; err: unknown }
  | { status: 'blockhash_expired' }
  | { status: 'timeout' };

const COMMITMENT_RANK: Record<'processed' | 'confirmed' | 'finalized', number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

/** Shared L1/ER transaction-submission and confirmation surface. Both
 * `SolanaL1Transport` and `MagicRouterTransport` mix this in rather than
 * duplicating it, since an ephemeral rollup validator speaks the same
 * Solana JSON-RPC methods for these operations. */
class TransactionTransport extends JsonRpcTransport {
  latestBlockhash(commitment: 'confirmed' | 'finalized' = 'finalized') {
    return this.call<BlockhashResult>('getLatestBlockhash', [{ commitment }]);
  }

  multipleAccounts(addresses: string[], commitment: 'confirmed' | 'finalized' = 'finalized') {
    return this.call<MultipleAccountsResult>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment }]);
  }

  signatureStatuses(signatures: string[]) {
    return this.call<SignatureStatusesResult>('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
  }

  /** `transactionBase64` is a fully signed transaction, base64-encoded. */
  simulateTransaction(transactionBase64: string, commitment: 'processed' | 'confirmed' | 'finalized' = 'processed') {
    return this.call<SimulateTransactionResult>('simulateTransaction', [
      transactionBase64,
      { encoding: 'base64', commitment, sigVerify: true },
    ]);
  }

  /** Returns the transaction signature on RPC acceptance -- this says
   * nothing about confirmation; call `confirmTransaction` (or poll
   * `signatureStatuses`) afterward. */
  sendTransaction(transactionBase64: string, options: SendTransactionOptions = {}) {
    return this.call<string>('sendTransaction', [
      transactionBase64,
      { encoding: 'base64', skipPreflight: options.skipPreflight ?? false, preflightCommitment: options.preflightCommitment ?? 'confirmed', maxRetries: options.maxRetries },
    ]);
  }

  /**
   * Polls `signatureStatuses` until `signature` reaches at least
   * `targetCommitment`, distinguishing "confirmed" from "finalized" via
   * the RPC's own `confirmationStatus` rather than inferring it from
   * elapsed time. Detects blockhash expiry (the transaction can no longer
   * land, ever, once the network's block height passes
   * `lastValidBlockHeight` without seeing this signature) so a keeper
   * knows to rebuild and resubmit rather than keep waiting.
   */
  async confirmTransaction(signature: string, options: ConfirmOptions): Promise<ConfirmationOutcome> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const result = await this.signatureStatuses([signature]);
      const status = result.value[0];
      if (status) {
        if (status.err) return { status: 'failed', err: status.err };
        if (status.confirmationStatus && COMMITMENT_RANK[status.confirmationStatus] >= COMMITMENT_RANK[options.targetCommitment]) {
          return { status: status.confirmationStatus === 'finalized' ? 'finalized' : 'confirmed' };
        }
        // Landed but below target commitment: keep polling without
        // re-checking blockhash expiry (a landed transaction is safe from
        // expiry regardless of the network's current block height).
      } else {
        // Not observed yet: a transaction can only still land while the
        // network's block height has not yet passed the blockhash's own
        // `lastValidBlockHeight` -- past that point it never will, no
        // matter how long this keeps polling.
        const currentHeight = await this.blockHeight('confirmed');
        if (currentHeight > options.lastValidBlockHeight) return { status: 'blockhash_expired' };
      }
      await sleep(pollIntervalMs);
    }
    return { status: 'timeout' };
  }

  blockHeight(commitment: 'confirmed' | 'finalized' = 'finalized') {
    return this.call<number>('getBlockHeight', [{ commitment }]);
  }
}

export class SolanaL1Transport extends TransactionTransport {
  account(address: string, commitment: 'confirmed' | 'finalized' = 'finalized') {
    return this.call<AccountInfoResult>('getAccountInfo', [address, { encoding: 'base64', commitment }]);
  }
  signatures(address: string, before?: string) {
    return this.call<Array<{ signature: string; slot: number; err: unknown }>>('getSignaturesForAddress', [address, { before, limit: 1000, commitment: 'confirmed' }]);
  }
  transaction(signature: string) {
    return this.call<unknown>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  }
}

/** The delegation-status byte offset within a StockStream market
 * account's raw data, matching `programs/stockstream/src/state.rs`'s
 * `RESERVED_DELEGATION_STATUS` field within `reserved_upgrade`
 * (`offset_of!(MarketStateHeader, reserved_upgrade) + RESERVED_DELEGATION_STATUS`
 * = 327 + 2). Kept here (not decoded generically) because Magic Router
 * routing is the one transport-layer decision that genuinely needs to
 * know this single byte -- everything else about the account stays opaque
 * to this module, consistent with the rest of this file. */
const DELEGATION_STATUS_OFFSET = 329;
/** Mirrors `state::DelegationStatus` -- delegated states route writes to
 * the ER; everything else routes to L1. */
// Mirrors `state::DelegationStatus`: NotDelegated=0, Delegated=1,
// Undelegating=2, Restored=3. Delegated and Undelegating both still route
// to the ER (Undelegating is still ER-authoritative until the delegation
// program's external-undelegate callback lands).
const DELEGATED_STATUS_VALUES = new Set([1, 2]);

export type WritableAccountDomain = 'l1' | 'er';

/** Classifies which domain a writable market account's transactions
 * should currently be routed to, from its own raw account bytes (as
 * returned by `account()`/`multipleAccounts()`) -- never mixing L1 and ER
 * writable domains in one transaction is a MagicBlock requirement this
 * function exists to let a caller enforce. */
export function classifyWritableAccountDomain(accountBytes: Uint8Array): WritableAccountDomain {
  if (accountBytes.length <= DELEGATION_STATUS_OFFSET) return 'l1';
  return DELEGATED_STATUS_VALUES.has(accountBytes[DELEGATION_STATUS_OFFSET]) ? 'er' : 'l1';
}

export class MagicRouterTransport extends TransactionTransport {
  account(address: string) {
    return this.call<AccountInfoResult>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  }
  status(signature: string) {
    return this.call<unknown>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
  }
}

/** Kept as an alias so existing imports (`ingestion-pipeline.ts`,
 * `private-sessions.ts`) keep working -- `MagicRouterTransport` is the
 * Priority 8 name reflecting that this speaks to the Magic Router, not a
 * bare ER validator. */
export { MagicRouterTransport as MagicBlockErTransport };
