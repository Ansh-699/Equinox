import { recordErTx } from './er-latency';
import { firstSignature, type ErSocket } from './er-socket';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { decodeMarketState, decodeTradingSession, type TradingSessionView } from '../clients/stockstream/src';
import { STOCKSTREAM_PROGRAM_ID } from '../clients/stockstream/src/constants';
import type { L1Transport, RouterBoundary } from './execution-boundary';

type Fetch = typeof fetch;
export class RpcFailure extends Error {
  constructor(readonly method: string, readonly code: number | string) { super(`RPC ${method} failed (${code})`); }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC object');
  return value as Record<string, unknown>;
};
function key(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid public key');
  return new PublicKey(value).toBase58();
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid RPC integer');
  return Number(value);
}

export class SolanaRpcTransport implements L1Transport {
  private id = 0;
  // Real browsers brand fetch as a Window/WorkerGlobalScope method: a bare
  // `fetch` reference called as `this.fetcher(...)` (this = the transport
  // instance, not window) throws "Illegal invocation". Node's fetch has no
  // such branding check, so vitest never caught this -- only a real
  // browser (Playwright) does. Binding here fixes every call site without
  // requiring every constructor caller to remember to do it themselves.
  constructor(readonly endpoint: string, private readonly fetcher: Fetch = fetch.bind(globalThis),
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly attempts = 30) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
      throw new Error('RPC requires HTTPS');
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Invalid polling bound');
  }
  async request(method: string, params: unknown[]): Promise<unknown> {
    const id = ++this.id;
    const response = await this.fetcher(this.endpoint, { method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params}), signal:AbortSignal.timeout(15_000) });
    if (!response.ok) throw new RpcFailure(method, response.status);
    const data = object(await response.json());
    if (data.id !== id || data.jsonrpc !== '2.0') throw new RpcFailure(method, 'invalid_envelope');
    if (data.error) throw new RpcFailure(method, String(object(data.error).code));
    if (!('result' in data)) throw new RpcFailure(method, 'missing_result');
    return data.result;
  }
  async latestBlockhash(): Promise<{blockhash:string;lastValidBlockHeight:number}> {
    const value = object(object(await this.request('getLatestBlockhash',[{commitment:'confirmed'}])).value);
    return {blockhash:key(value.blockhash),lastValidBlockHeight:count(value.lastValidBlockHeight)};
  }
  /** Diagnostics-only: the current slot this RPC endpoint sees. Not used
   * by any transaction-lifecycle logic. */
  async currentSlot(): Promise<number> {
    return count(await this.request('getSlot',[{commitment:'confirmed'}]));
  }
  /** Native SOL balance in lamports, for portfolio display only. */
  async solBalance(address: string): Promise<bigint> {
    const result = object(await this.request('getBalance',[key(address),{commitment:'confirmed'}]));
    return BigInt(count(result.value));
  }
  async simulate(bytes: Uint8Array): Promise<{units:number}> {
    const value = object(object(await this.request('simulateTransaction',[
      Buffer.from(bytes).toString('base64'), {encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed'}])).value);
    if (value.err !== null) throw new RpcFailure('simulateTransaction','simulation_rejected');
    return {units:count(value.unitsConsumed)};
  }
  async submit(bytes: Uint8Array): Promise<{signature:string}> {
    // No automatic send retry: a transport timeout is an ambiguous submission.
    const signature = await this.request('sendTransaction',[Buffer.from(bytes).toString('base64'),
      {encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'}]);
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))
      throw new RpcFailure('sendTransaction','invalid_signature');
    return {signature};
  }
  async confirm(signature: string): Promise<'confirmed'|'finalized'> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw new Error('Invalid signature');
    for (let attempt=0; attempt<this.attempts; attempt++) {
      const values = object(await this.request('getSignatureStatuses',[[signature],{searchTransactionHistory:true}])).value;
      if (!Array.isArray(values) || values.length !== 1) throw new RpcFailure('getSignatureStatuses','invalid_result');
      if (values[0] !== null) {
        const status = object(values[0]);
        if (status.err !== null) throw new RpcFailure('getSignatureStatuses','transaction_rejected');
        if (status.confirmationStatus === 'finalized' || status.confirmationStatus === 'confirmed') return status.confirmationStatus;
      }
      if (attempt+1<this.attempts) await this.wait(500);
    }
    throw new RpcFailure('getSignatureStatuses','confirmation_timeout');
  }
  async market(address: string, commitment: 'confirmed'|'finalized' = 'confirmed') {
    const response = object(await this.request('getAccountInfo',[key(address),{encoding:'base64',commitment}]));
    const value = object(response.value);
    if (value.owner !== STOCKSTREAM_PROGRAM_ID || value.executable !== false || !Array.isArray(value.data) || value.data[1] !== 'base64' || typeof value.data[0] !== 'string')
      throw new RpcFailure('getAccountInfo','invalid_market_owner_or_data');
    const bytes = Buffer.from(value.data[0], 'base64');
    const state = decodeMarketState(bytes);
    if (!state.initialized) throw new RpcFailure('getAccountInfo','uninitialized_market');
    return { state, bytes, eventSequence:bytes.readBigUInt64LE(262), commitSequence:bytes.readBigUInt64LE(330), restoredSequence:bytes.readBigUInt64LE(338) };
  }
  /** Account bytes with no owner check (e.g. a shard held by the delegation program). */
  async rawAccountBytes(address: string): Promise<Buffer | null> {
    const value = object(await this.request('getAccountInfo',[key(address),{encoding:'base64',commitment:'confirmed'}])).value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = object(value).data;
    return Array.isArray(data) && typeof data[0] === 'string' ? Buffer.from(data[0], 'base64') : null;
  }
  /** Reads raw program-owned account bytes for versioned V3 decoders. */
  async accountBytes(address: string, commitment: 'confirmed'|'finalized' = 'confirmed'): Promise<Buffer> {
    const response = object(await this.request('getAccountInfo',[key(address),{encoding:'base64',commitment}]));
    const value = response.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcFailure('getAccountInfo','account_not_found');
    const record = object(value);
    if (record.owner !== STOCKSTREAM_PROGRAM_ID || record.executable !== false || !Array.isArray(record.data) || record.data[1] !== 'base64' || typeof record.data[0] !== 'string')
      throw new RpcFailure('getAccountInfo','invalid_program_owner_or_data');
    return Buffer.from(record.data[0], 'base64');
  }
  /** Reads back an AuthorizeTradingSession/RevokeTradingSession result.
   * Returns null if the PDA has never been created (not yet authorized),
   * and throws if an account exists but is not a StockStream-owned
   * TradingSession -- the caller must never treat that as "not authorized". */
  async tradingSession(address: string, commitment: 'confirmed'|'finalized' = 'confirmed'): Promise<TradingSessionView | null> {
    const response = object(await this.request('getAccountInfo',[key(address),{encoding:'base64',commitment}]));
    if (response.value === null) return null;
    const value = object(response.value);
    if (value.owner !== STOCKSTREAM_PROGRAM_ID || value.executable !== false || !Array.isArray(value.data) || value.data[1] !== 'base64' || typeof value.data[0] !== 'string')
      throw new RpcFailure('getAccountInfo','invalid_session_owner_or_data');
    return decodeTradingSession(Buffer.from(value.data[0], 'base64'));
  }
  async tokenBalance(tokenAccount: string, commitment: 'confirmed'|'finalized' = 'confirmed'): Promise<bigint> {
    const value = object(object(await this.request('getTokenAccountBalance',[key(tokenAccount),{commitment}])).value);
    if (typeof value.amount !== 'string' || !/^\d+$/.test(value.amount)) throw new RpcFailure('getTokenAccountBalance','invalid_amount');
    return BigInt(value.amount);
  }
  async confirmCommit(market: string, expected: bigint): Promise<{status:'l1_committed';sequence:bigint}> {
    if (expected <= 0n) throw new Error('Invalid commit sequence');
    for (let attempt=0; attempt<this.attempts; attempt++) {
      const state = await this.market(market,'finalized');
      if (state.commitSequence >= expected) return {status:'l1_committed',sequence:state.commitSequence};
      if (attempt+1<this.attempts) await this.wait(1000);
    }
    throw new RpcFailure('getAccountInfo','commit_delayed');
  }
}

/** The rollup that holds the market, reached directly (no router hop). */
export interface DirectRollup { validator: string; rpc: SolanaRpcTransport; socket: ErSocket }

export class MagicRouterTransport implements RouterBoundary {
  private readonly delegationCache = new Map<string, { validator: string; until: number }>();
  private viaRollup = false;
  private blockhash: { value: string; until: number } | null = null;
  constructor(private readonly rpc: SolanaRpcTransport, private readonly marketAddress: string, private readonly direct?: DirectRollup) { key(marketAddress); }
  async getAccountAwareBlockhash(writableAccounts: readonly string[]): Promise<string> {
    if (!writableAccounts.length || writableAccounts.length>64 || new Set(writableAccounts).size !== writableAccounts.length || !writableAccounts.includes(this.marketAddress))
      throw new Error('Invalid writable account cluster');
    // In parallel, and cached briefly: a serial check per account cost seconds per order.
    const validators = await Promise.all(writableAccounts.map(async (account) => {
      const cached = this.delegationCache.get(account);
      if (cached && cached.until > Date.now()) return cached.validator;
      const status = object(await this.rpc.request('getDelegationStatus',[key(account)]));
      if (status.isDelegated !== true) throw new Error('Mixed or undelegated writable account');
      const validator = key(object(status.delegationRecord).authority);
      this.delegationCache.set(account, { validator, until: Date.now() + 30_000 });
      return validator;
    }));
    if (new Set(validators).size !== 1) throw new Error('Mixed validators');
    // Every writable account sits on the rollup we know: talk to it directly.
    this.viaRollup = !!this.direct && validators[0] === this.direct.validator;
    if (this.viaRollup) {
      // Reused briefly: each transaction still differs (fresh client order ids / amounts).
      if (!this.blockhash || this.blockhash.until < Date.now()) this.blockhash = { value: (await this.direct!.rpc.latestBlockhash()).blockhash, until: Date.now() + 2_000 };
      return this.blockhash.value;
    }
    const result = object(await this.rpc.request('getBlockhashForAccounts',[writableAccounts]));
    count(result.lastValidBlockHeight);
    return key(result.blockhash);
  }
  async submit(serialized: Uint8Array, kind = 'tx'): Promise<{status:'er_accepted';sequence:bigint}> {
    if (this.viaRollup && this.direct) {
      const signature = firstSignature(serialized);
      // Subscribed before the clock starts: the time is network + rollup execution, nothing else.
      const watch = await this.direct.socket.watch(signature).catch(() => null);
      const startedAt = Date.now();
      const t0 = performance.now();
      await this.direct.rpc.submit(serialized);
      const processed = watch ? await watch.done : null;
      if (processed) {
        recordErTx({ kind, ms: Math.round(processed.at - t0), netMs: watch!.pingMs, ok: processed.ok, at: startedAt, signature });
        if (!processed.ok) throw new RpcFailure('signatureNotification','transaction_rejected');
        return {status:'er_accepted',sequence:0n};
      }
      await this.direct.rpc.confirm(signature).then(
        () => recordErTx({ kind, ms: Date.now() - startedAt, netMs: watch?.pingMs ?? null, ok: true, at: startedAt, signature }),
        (error: unknown) => { recordErTx({ kind, ms: null, netMs: null, ok: false, at: startedAt, signature }); throw error; });
      return {status:'er_accepted',sequence:0n};
    }
    const startedAt = Date.now();
    const {signature} = await this.rpc.submit(serialized);
    try {
      await this.rpc.confirm(signature);
      recordErTx({ kind, ms: Date.now() - startedAt, netMs: null, ok: true, at: startedAt, signature });
    } catch (error) {
      recordErTx({ kind, ms: null, netMs: null, ok: false, at: startedAt, signature });
      throw error;
    }
    return {status:'er_accepted',sequence:0n};
  }
}
