import { describe, expect, it } from 'vitest';
import { MagicRouterTransport, RpcFailure, SolanaRpcTransport } from './rpc-transport';
import { STOCKSTREAM_ACCOUNT_SIZE, STOCKSTREAM_PROGRAM_ID } from '../clients/stockstream/src/constants';

const marketAddress = 'H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET';
const signature = '2'.repeat(64);
function response(id: number, result: unknown) { return new Response(JSON.stringify({jsonrpc:'2.0',id,result}), {headers:{'content-type':'application/json'}}); }
function marketBytes(commit = 4n, event = 7n) {
  const bytes = Buffer.alloc(STOCKSTREAM_ACCOUNT_SIZE);
  bytes.write('STKMRK01'); bytes.writeUInt16LE(2,8); bytes[10]=1; bytes[11]=1;
  Buffer.from(new Uint8Array(32).fill(1)).copy(bytes,12);
  bytes[294]=1; bytes.writeBigInt64LE(100n,295); bytes.writeBigUInt64LE(1n,303);
  bytes.writeUInt32LE(512,311); bytes.writeUInt32LE(91152,315); bytes.writeUInt32LE(181792,319); bytes.writeUInt32LE(214560,323);
  bytes.writeBigUInt64LE(event,262); bytes.writeBigUInt64LE(commit,330);
  return bytes;
}
describe('production RPC transports', () => {
  it('simulates, submits once, confirms, and validates the market owner', async () => {
    const calls: string[]=[];
    const fetcher: typeof fetch = async (_input, init) => {
      const request=JSON.parse(String(init?.body)); calls.push(request.method);
      if(request.method==='simulateTransaction') return response(request.id,{value:{err:null,unitsConsumed:123}});
      if(request.method==='sendTransaction') return response(request.id,signature);
      if(request.method==='getSignatureStatuses') return response(request.id,{value:[{err:null,confirmationStatus:'finalized'}]});
      if(request.method==='getAccountInfo') return response(request.id,{value:{owner:STOCKSTREAM_PROGRAM_ID,executable:false,data:[marketBytes().toString('base64'),'base64']}});
      throw new Error(request.method);
    };
    const rpc=new SolanaRpcTransport('https://rpc.test',fetcher,async()=>{},1);
    expect(await rpc.simulate(Uint8Array.of(1))).toEqual({units:123});
    expect(await rpc.submit(Uint8Array.of(1))).toEqual({signature});
    expect(await rpc.confirm(signature)).toBe('finalized');
    expect((await rpc.confirmCommit(marketAddress,4n)).sequence).toBe(4n);
    expect(calls.filter(call=>call==='sendTransaction')).toHaveLength(1);
  });
  it('rejects simulation errors and never submits them', async () => {
    const calls:string[]=[];
    const rpc=new SolanaRpcTransport('https://rpc.test',async(_input,init)=>{
      const body=JSON.parse(String(init?.body)); calls.push(body.method); return response(body.id,{value:{err:{InstructionError:[0,'Custom']},unitsConsumed:1}});
    });
    await expect(rpc.simulate(Uint8Array.of(1))).rejects.toBeInstanceOf(RpcFailure);
    expect(calls).toEqual(['simulateTransaction']);
  });
  it('router requires one delegated validator and confirms ER acceptance by readback', async () => {
    let id=0;
    const rpc=new SolanaRpcTransport('https://router.test',async(_input,init)=>{
      const body=JSON.parse(String(init?.body)); id=body.id;
      if(body.method==='getDelegationStatus') return response(id,{isDelegated:true,delegationRecord:{authority:marketAddress}});
      if(body.method==='getBlockhashForAccounts') return response(id,{blockhash:marketAddress,lastValidBlockHeight:10});
      if(body.method==='sendTransaction') return response(id,signature);
      if(body.method==='getSignatureStatuses') return response(id,{value:[{err:null,confirmationStatus:'confirmed'}]});
      if(body.method==='getAccountInfo') return response(id,{value:{owner:STOCKSTREAM_PROGRAM_ID,executable:false,data:[marketBytes().toString('base64'),'base64']}});
      throw new Error(body.method);
    },async()=>{},1);
    const router=new MagicRouterTransport(rpc,marketAddress);
    expect(await router.getAccountAwareBlockhash([marketAddress])).toBe(marketAddress);
    expect(await router.submit(Uint8Array.of(1))).toEqual({status:'er_accepted',sequence:7n});
  });
  it('router rejects undelegated writable accounts before requesting a blockhash', async () => {
    const rpc=new SolanaRpcTransport('https://router.test',async(_input,init)=>response(JSON.parse(String(init?.body)).id,{isDelegated:false}));
    await expect(new MagicRouterTransport(rpc,marketAddress).getAccountAwareBlockhash([marketAddress])).rejects.toThrow('undelegated');
  });
  it('reads back a token account balance for vault/custody readback', async () => {
    const rpc=new SolanaRpcTransport('https://rpc.test',async(_input,init)=>{
      const body=JSON.parse(String(init?.body));
      if(body.method==='getTokenAccountBalance') return response(body.id,{value:{amount:'5000000',decimals:6,uiAmount:5,uiAmountString:'5'}});
      throw new Error(body.method);
    });
    expect(await rpc.tokenBalance(marketAddress)).toBe(5_000_000n);
  });
  it('rejects a malformed token balance response', async () => {
    const rpc=new SolanaRpcTransport('https://rpc.test',async(_input,init)=>{
      const body=JSON.parse(String(init?.body)); return response(body.id,{value:{amount:'not-a-number'}});
    });
    await expect(rpc.tokenBalance(marketAddress)).rejects.toBeInstanceOf(RpcFailure);
  });
});
