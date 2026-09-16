import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PythLazerClient, type ParsedFeedPayload } from '@pythnetwork/pyth-lazer-sdk';
import { consumeOracleUpdate } from '../../clients/stockstream/src';
import { requirePythServerConfig } from '../oracle';

const ED25519_PROGRAM = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const PROPERTIES = ['price','exponent','confidence','marketSession','feedUpdateTimestamp'] as const;
export interface SignedPythUpdate { message:Uint8Array;feedId:number;timestamp:number;payloadHash:string;parsed:ParsedFeedPayload }
export interface PythKeeperConfig { apiKey:string;feedId:number;endpoints:readonly string[];channel:'fixed_rate@200ms';accounts:{market:string;payer:string;pythProgram:string;storage:string;treasury:string;systemProgram:string;instructionsSysvar:string} }
export interface PythClient { getLatestPrice(input:{priceFeedIds:number[];properties:typeof PROPERTIES;formats:['solana'];jsonBinaryEncoding:'base64';parsed:true;channel:'fixed_rate@200ms'}):Promise<{solana?:{encoding:'base64'|'hex';data:string};parsed?:{timestampUs:string;priceFeeds:ParsedFeedPayload[]}}> }
type ClientFactory=(config:PythKeeperConfig)=>Promise<PythClient>;

export function loadPythKeeperConfig(env:Record<string,string|undefined>):PythKeeperConfig {
  const base=requirePythServerConfig(env); const feedId=Number(base.feedId);
  if(!Number.isSafeInteger(feedId)||feedId<=0) throw new Error('PYTH_PRO_FEED_ID must be an authenticated numeric Pyth Pro ID');
  const endpoints=(env.PYTH_PRO_ENDPOINTS??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!endpoints.length) throw new Error('PYTH_PRO_ENDPOINTS is required');
  for(const endpoint of endpoints) if(new URL(endpoint).protocol!=='wss:') throw new Error('Pyth endpoints must use wss');
  const names=['STOCKSTREAM_MARKET_ADDRESS','KEEPER_PUBLIC_KEY','PYTH_PROGRAM_ADDRESS','PYTH_STORAGE_ADDRESS','PYTH_TREASURY_ADDRESS'] as const;
  for(const name of names) if(!env[name]) throw new Error(`${name} is required`);
  return {apiKey:base.apiKey,feedId,endpoints,channel:'fixed_rate@200ms',accounts:{market:env.STOCKSTREAM_MARKET_ADDRESS!,payer:env.KEEPER_PUBLIC_KEY!,pythProgram:env.PYTH_PROGRAM_ADDRESS!,storage:env.PYTH_STORAGE_ADDRESS!,treasury:env.PYTH_TREASURY_ADDRESS!,systemProgram:SYSTEM_PROGRAM,instructionsSysvar:'Sysvar1nstructions1111111111111111111111111'}};
}
const defaultFactory:ClientFactory=async config=>{
  const client=await PythLazerClient.create({token:config.apiKey,webSocketPoolConfig:{urls:[...config.endpoints]}});
  return {getLatestPrice: input => client.getLatestPrice({...input,properties:[...input.properties],formats:['solana']})};
};
function decode(data:{encoding:'base64'|'hex';data:string}):Uint8Array { return data.encoding==='hex'?Uint8Array.from(data.data.match(/../g)?.map(x=>Number.parseInt(x,16))??[]):Uint8Array.from(Buffer.from(data.data,'base64')); }
function ed25519(message:Uint8Array):TransactionInstruction {
  if(message.length<103||message.length>512) throw new Error('Invalid signed Solana message');
  const size=new DataView(message.buffer,message.byteOffset,message.byteLength).getUint16(100,true);
  if(message.length!==102+size) throw new Error('Invalid signed Solana message framing');
  const data=new Uint8Array(16); data[0]=1; const view=new DataView(data.buffer);
  view.setUint16(2,5,true); view.setUint16(4,1,true); view.setUint16(6,69,true); view.setUint16(8,1,true);
  view.setUint16(10,103,true); view.setUint16(12,size,true); view.setUint16(14,1,true);
  return new TransactionInstruction({programId:ED25519_PROGRAM,keys:[],data:Buffer.from(data)});
}
export class PythKeeper {
  private client?:PythClient; private lastTimestamp=0; private lastHash='';
  constructor(private readonly config:PythKeeperConfig,private readonly factory:ClientFactory=defaultFactory) {}
  private async connection(){ return this.client??=(await this.factory(this.config)); }
  async fetchSignedUpdate():Promise<SignedPythUpdate> {
    const result=await (await this.connection()).getLatestPrice({priceFeedIds:[this.config.feedId],properties:PROPERTIES,formats:['solana'],jsonBinaryEncoding:'base64',parsed:true,channel:this.config.channel});
    const parsed=result.parsed?.priceFeeds; if(!result.solana||!result.parsed||parsed?.length!==1||parsed[0].priceFeedId!==this.config.feedId) throw new Error('Incomplete Pyth Pro response');
    const timestamp=Number(BigInt(result.parsed.timestampUs)/1_000_000n); const message=decode(result.solana);
    const payloadHash=createHash('sha256').update(message).digest('hex');
    if(timestamp<=this.lastTimestamp||payloadHash===this.lastHash) throw new Error('Duplicate or older Pyth update');
    this.lastTimestamp=timestamp; this.lastHash=payloadHash;
    return {message,feedId:this.config.feedId,timestamp,payloadHash,parsed:parsed[0]};
  }
  buildTransaction(update:SignedPythUpdate):TransactionInstruction[] {
    if(update.feedId!==this.config.feedId) throw new Error('Unexpected Pyth feed');
    return [ed25519(update.message),consumeOracleUpdate(this.config.accounts,update.message)];
  }
  get health(){return{configured:true,feedId:this.config.feedId,lastTimestamp:this.lastTimestamp,lastPayloadHash:this.lastHash};}
}
export function pythHealth(env:Record<string,string|undefined>){return{configured:Boolean(env.PYTH_PRO_API_KEY&&env.PYTH_PRO_FEED_ID),liveVerification:false,feedIdConfigured:Boolean(env.PYTH_PRO_FEED_ID)};}
