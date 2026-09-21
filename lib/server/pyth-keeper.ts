import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PythLazerClient, type ParsedFeedPayload } from '@pythnetwork/pyth-lazer-sdk';
import { consumeOracleUpdate, CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET } from '../../clients/stockstream/src';
import { requirePythServerConfig } from '../oracle';

const ED25519_PROGRAM = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const PROPERTIES = ['price','exponent','confidence','marketSession','feedUpdateTimestamp'] as const;
const PYTH_CHANNELS = ['real_time','fixed_rate@50ms','fixed_rate@200ms','fixed_rate@1000ms'] as const;
type PythChannel = typeof PYTH_CHANNELS[number];
export interface SignedPythUpdate { message:Uint8Array;feedId:number;timestamp:number;payloadHash:string;parsed:ParsedFeedPayload }
export interface PythKeeperConfig { apiKey:string;feedId:number;endpoints:readonly string[];channel:PythChannel;accounts:{market:string;payer:string;pythProgram:string;storage:string;treasury:string;systemProgram:string;instructionsSysvar:string} }
export interface PythClient { getLatestPrice(input:{priceFeedIds:number[];properties:typeof PROPERTIES;formats:['solana'];jsonBinaryEncoding:'base64';parsed:true;channel:PythChannel}):Promise<{solana?:{encoding:'base64'|'hex';data:string};parsed?:{timestampUs:string;priceFeeds:ParsedFeedPayload[]}}> }
type ClientFactory=(config:PythKeeperConfig)=>Promise<PythClient>;

export function loadPythKeeperConfig(env:Record<string,string|undefined>):PythKeeperConfig {
  const base=requirePythServerConfig(env); const feedId=Number(base.feedId);
  if(!Number.isSafeInteger(feedId)||feedId<=0) throw new Error('PYTH_PRO_FEED_ID must be an authenticated numeric Pyth Pro ID');
  const endpoints=(env.PYTH_PRO_ENDPOINTS??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!endpoints.length) throw new Error('PYTH_PRO_ENDPOINTS is required');
  for(const endpoint of endpoints) if(new URL(endpoint).protocol!=='wss:') throw new Error('Pyth endpoints must use wss');
  const channel=env.PYTH_PRO_MIN_CHANNEL??'fixed_rate@200ms';
  if(!PYTH_CHANNELS.includes(channel as PythChannel)) throw new Error('PYTH_PRO_MIN_CHANNEL must be a documented Pyth Pro channel');
  const names=['STOCKSTREAM_MARKET_ADDRESS','KEEPER_PUBLIC_KEY','PYTH_PROGRAM_ADDRESS','PYTH_STORAGE_ADDRESS','PYTH_TREASURY_ADDRESS'] as const;
  for(const name of names) if(!env[name]) throw new Error(`${name} is required`);
  return {apiKey:base.apiKey,feedId,endpoints,channel:channel as PythChannel,accounts:{market:env.STOCKSTREAM_MARKET_ADDRESS!,payer:env.KEEPER_PUBLIC_KEY!,pythProgram:env.PYTH_PROGRAM_ADDRESS!,storage:env.PYTH_STORAGE_ADDRESS!,treasury:env.PYTH_TREASURY_ADDRESS!,systemProgram:SYSTEM_PROGRAM,instructionsSysvar:'Sysvar1nstructions1111111111111111111111111'}};
}
const defaultFactory:ClientFactory=async config=>{
  const client=await PythLazerClient.create({token:config.apiKey,webSocketPoolConfig:{urls:[...config.endpoints]}});
  return {getLatestPrice: input => client.getLatestPrice({...input,properties:[...input.properties],formats:['solana']})};
};
function decode(data:{encoding:'base64'|'hex';data:string}):Uint8Array { return data.encoding==='hex'?Uint8Array.from(data.data.match(/../g)?.map(x=>Number.parseInt(x,16))??[]):Uint8Array.from(Buffer.from(data.data,'base64')); }
/**
 * Builds the native Ed25519 precompile instruction whose offsets point at
 * the signed message embedded in the *following* `ConsumeOracleUpdate`
 * instruction's own data, at `CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET` (4).
 * `consumerInstructionIndex` is this transaction's actual index for that
 * instruction (not assumed to be a fixed value) -- see
 * `signature::Ed25519SignatureOffsets` in the real
 * `pyth-lazer-solana-contract`, which requires `signature_instruction_index
 * == public_key_instruction_index == message_instruction_index ==` the
 * *current* (calling) instruction's own index, not the Ed25519 instruction's.
 */
function ed25519(message:Uint8Array, consumerInstructionIndex:number):TransactionInstruction {
  if(message.length<102||message.length>512) throw new Error('Invalid signed Solana message');
  const size=new DataView(message.buffer,message.byteOffset,message.byteLength).getUint16(100,true);
  if(message.length!==102+size) throw new Error('Invalid signed Solana message framing');
  if(!Number.isInteger(consumerInstructionIndex)||consumerInstructionIndex<0||consumerInstructionIndex>0xffff) throw new Error('Invalid consumer instruction index');
  // Exact arithmetic from `Ed25519SignatureOffsets::new` in the real
  // pyth-lazer-solana-contract (`signature.rs`): starting_offset is where
  // the message's own 4-byte magic begins within the *calling*
  // (ConsumeOracleUpdate) instruction's data.
  const MAGIC_LEN=4, SIGNATURE_LEN=64, PUBKEY_LEN=32, MESSAGE_SIZE_LEN=2;
  const startingOffset=CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET;
  const signatureOffset=startingOffset+MAGIC_LEN;
  const publicKeyOffset=signatureOffset+SIGNATURE_LEN;
  const messageDataOffset=publicKeyOffset+PUBKEY_LEN+MESSAGE_SIZE_LEN;
  const data=new Uint8Array(16); data[0]=1; const view=new DataView(data.buffer);
  view.setUint16(2,signatureOffset,true);
  view.setUint16(4,consumerInstructionIndex,true);
  view.setUint16(6,publicKeyOffset,true);
  view.setUint16(8,consumerInstructionIndex,true);
  view.setUint16(10,messageDataOffset,true);
  view.setUint16(12,size,true);
  view.setUint16(14,consumerInstructionIndex,true);
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
  /**
   * `baseIndex` is the Ed25519 instruction's actual position in the final
   * transaction (default 0, i.e. first). If the caller prepends other
   * instructions (e.g. a compute-budget instruction), pass its real index
   * here -- the program independently verifies whatever is claimed against
   * the Instructions sysvar, so a wrong value here fails closed rather than
   * silently misverifying.
   */
  buildTransaction(update:SignedPythUpdate, baseIndex=0):TransactionInstruction[] {
    if(update.feedId!==this.config.feedId) throw new Error('Unexpected Pyth feed');
    const consumerIndex=baseIndex+1;
    return [
      ed25519(update.message,consumerIndex),
      consumeOracleUpdate(this.config.accounts,update.message,baseIndex,0),
    ];
  }
  get health(){return{configured:true,feedId:this.config.feedId,lastTimestamp:this.lastTimestamp,lastPayloadHash:this.lastHash};}
}
export function pythHealth(env:Record<string,string|undefined>){return{configured:Boolean(env.PYTH_PRO_API_KEY&&env.PYTH_PRO_FEED_ID),liveVerification:false,feedIdConfigured:Boolean(env.PYTH_PRO_FEED_ID)};}
