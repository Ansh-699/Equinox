/** Concrete JSON-RPC adapters used by the indexer. They deliberately return
 * raw RPC values: decoding StockStream account/event bytes remains a protocol
 * concern in the indexer, not a trust decision made by a transport. */
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
    const body = await response.json() as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'RPC error');
    if (body.result === undefined) throw new Error('RPC response missing result');
    return body.result;
  }
}

export class SolanaL1Transport extends JsonRpcTransport {
  account(address: string, commitment: 'confirmed' | 'finalized' = 'finalized') {
    return this.call<{ value: { data: [string, string] | null; owner: string; lamports: number } }>('getAccountInfo', [address, { encoding: 'base64', commitment }]);
  }
  signatures(address: string, before?: string) {
    return this.call<Array<{ signature: string; slot: number; err: unknown }>>('getSignaturesForAddress', [address, { before, limit: 1000, commitment: 'confirmed' }]);
  }
  transaction(signature: string) {
    return this.call<unknown>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  }
}

export class MagicBlockErTransport extends JsonRpcTransport {
  account(address: string) {
    return this.call<unknown>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  }
  status(signature: string) {
    return this.call<unknown>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
  }
}
