import { PublicKey } from '@solana/web3.js';
import { decodeMarketState } from '../clients/stockstream/src';
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
  constructor(private readonly endpoint: string, private readonly fetcher: Fetch = fetch,
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

export class MagicRouterTransport implements RouterBoundary {
  constructor(private readonly rpc: SolanaRpcTransport, private readonly marketAddress: string) { key(marketAddress); }
  async getAccountAwareBlockhash(writableAccounts: readonly string[]): Promise<string> {
    if (!writableAccounts.length || writableAccounts.length>64 || new Set(writableAccounts).size !== writableAccounts.length || !writableAccounts.includes(this.marketAddress))
      throw new Error('Invalid writable account cluster');
    let validator: string | undefined;
    for (const account of writableAccounts) {
      const status = object(await this.rpc.request('getDelegationStatus',[key(account)]));
      if (status.isDelegated !== true) throw new Error('Mixed or undelegated writable account');
      const authority = key(object(status.delegationRecord).authority);
      if (validator && validator !== authority) throw new Error('Mixed validators');
      validator = authority;
    }
    const result = object(await this.rpc.request('getBlockhashForAccounts',[writableAccounts]));
    count(result.lastValidBlockHeight);
    return key(result.blockhash);
  }
  async submit(serialized: Uint8Array): Promise<{status:'er_accepted';sequence:bigint}> {
    const {signature} = await this.rpc.submit(serialized);
    await this.rpc.confirm(signature);
    const market = await this.rpc.market(this.marketAddress);
    return {status:'er_accepted',sequence:market.eventSequence};
  }
}
