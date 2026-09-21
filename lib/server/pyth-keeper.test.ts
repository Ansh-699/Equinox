import { describe, expect, it } from 'vitest';
import { loadPythKeeperConfig, PythKeeper, pythHealth, type PythClient } from './pyth-keeper';

const address='11111111111111111111111111111111';
const env={PYTH_PRO_API_KEY:'server-only',PYTH_PRO_FEED_ID:'123',PYTH_PRO_MIN_CHANNEL:'fixed_rate@50ms',PYTH_PRO_ENDPOINTS:'wss://one,wss://two',STOCKSTREAM_MARKET_ADDRESS:address,KEEPER_PUBLIC_KEY:address,PYTH_PROGRAM_ADDRESS:address,PYTH_STORAGE_ADDRESS:address,PYTH_TREASURY_ADDRESS:address};
function message(){const data=new Uint8Array(103);new DataView(data.buffer).setUint16(100,1,true);data[102]=9;return data;}
describe('server-side Pyth keeper',()=>{
  it('requires server credentials, numeric catalog feed, and TLS websocket endpoints',()=>{
    expect(()=>loadPythKeeperConfig({})).toThrow('PYTH_PRO_API_KEY');
    expect(()=>loadPythKeeperConfig({...env,PYTH_PRO_FEED_ID:'Core-feed-hash'})).toThrow('numeric Pyth Pro ID');
    expect(()=>loadPythKeeperConfig({...env,PYTH_PRO_ENDPOINTS:'http://insecure'})).toThrow('wss');
    expect(()=>loadPythKeeperConfig({...env,PYTH_PRO_MIN_CHANNEL:'fixed_rate@25ms'})).toThrow('documented Pyth Pro channel');
    expect(loadPythKeeperConfig(env).channel).toBe('fixed_rate@50ms');
    expect(pythHealth({})).toEqual({configured:false,liveVerification:false,feedIdConfigured:false});
  });
  it('uses the SDK response and binds Ed25519 offsets to the following consumer instruction',async()=>{
    const client:PythClient={getLatestPrice:async input=>{
      expect(input.priceFeedIds).toEqual([123]);
      expect(input.channel).toBe('fixed_rate@50ms');
      expect(input.properties).toEqual(['price','exponent','confidence','marketSession','feedUpdateTimestamp']);
      return {solana:{encoding:'base64',data:Buffer.from(message()).toString('base64')},parsed:{timestampUs:'1000000000',priceFeeds:[{priceFeedId:123,price:'100',exponent:-2,confidence:1,marketSession:'regular',feedUpdateTimestamp:1_000_000_000}]}};
    }};
    const keeper=new PythKeeper(loadPythKeeperConfig(env),async()=>client);
    const update=await keeper.fetchSignedUpdate(); const instructions=keeper.buildTransaction(update);
    expect(instructions).toHaveLength(2); expect(instructions[0].programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    const offsets=new DataView(instructions[0].data.buffer,instructions[0].data.byteOffset,instructions[0].data.byteLength);
    expect([offsets.getUint16(2,true),offsets.getUint16(4,true),offsets.getUint16(10,true),offsets.getUint16(14,true)]).toEqual([8,1,106,1]);
    const consumerData=new DataView(instructions[1].data.buffer,instructions[1].data.byteOffset,instructions[1].data.byteLength);
    expect(consumerData.getUint16(1,true)).toBe(0); // ed25519_instruction_index (baseIndex=0)
    expect(instructions[1].data[3]).toBe(0); // signature_index
    expect(Buffer.from(instructions[1].data.slice(4))).toEqual(Buffer.from(message())); expect(keeper.health.lastTimestamp).toBe(1000);
    await expect(keeper.fetchSignedUpdate()).rejects.toThrow('Duplicate');
  });
  it('rejects malformed signed-message framing before transaction construction',()=>{
    const keeper=new PythKeeper(loadPythKeeperConfig(env),async()=>({} as PythClient));
    expect(()=>keeper.buildTransaction({message:new Uint8Array(103),feedId:123,timestamp:1,payloadHash:'x',parsed:{priceFeedId:123}})).toThrow('framing');
  });
});
