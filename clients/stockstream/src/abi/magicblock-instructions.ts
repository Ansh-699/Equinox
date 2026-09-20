import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { checkedUnsigned, writeUnsigned } from "./encoding";
import { accountMeta, instruction, publicKey, STOCKSTREAM_PROGRAM_KEY, type AddressInput } from "./transaction";

export const MAGICBLOCK_DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGICBLOCK_MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGICBLOCK_MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export interface DelegationAccounts { market: AddressInput; authority: AddressInput; instrument: AddressInput; payer: AddressInput; clusterAccounts?: AddressInput[]; }
export interface CommitAccounts { market: AddressInput; authority: AddressInput; payer: AddressInput; clusterAccounts?: AddressInput[]; }
export interface ClusterMemberAccounts { market: AddressInput; authority: AddressInput; member: AddressInput; payer: AddressInput; }

export function delegateMarket(accounts: DelegationAccounts, validator: AddressInput): TransactionInstruction {
  const market = publicKey(accounts.market); const validatorKey = publicKey(validator);
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), market.toBuffer()], STOCKSTREAM_PROGRAM_KEY);
  const [delegationRecord] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), market.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const [delegationMetadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), market.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const data = new Uint8Array(33); data[0] = OPCODE.delegateMarket; data.set(validatorKey.toBytes(), 1);
  return instruction(data, [accountMeta(market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.instrument, false, false), accountMeta(accounts.payer, true, true), accountMeta(buffer, false, true), accountMeta(delegationRecord, false, true), accountMeta(delegationMetadata, false, true), accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false), accountMeta(SystemProgram.programId, false, false), accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false), ...(accounts.clusterAccounts ?? []).map((a) => accountMeta(a, false, true))]);
}

export function delegateClusterMember(accounts: ClusterMemberAccounts, validator: AddressInput): TransactionInstruction {
  const market = publicKey(accounts.market); const member = publicKey(accounts.member); const validatorKey = publicKey(validator);
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), member.toBuffer()], STOCKSTREAM_PROGRAM_KEY);
  const [delegationRecord] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), member.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const [delegationMetadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), member.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const data = new Uint8Array(33); data[0] = OPCODE.delegateClusterMember; data.set(validatorKey.toBytes(), 1);
  return instruction(data, [accountMeta(market, false, false), accountMeta(accounts.authority, true, false), accountMeta(member, false, true), accountMeta(buffer, false, true), accountMeta(delegationRecord, false, true), accountMeta(delegationMetadata, false, true), accountMeta(accounts.payer, true, true), accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false), accountMeta(SystemProgram.programId, false, false), accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false)]);
}

export function deriveClusterMemberPdas(member: AddressInput): { buffer: PublicKey; delegationRecord: PublicKey; delegationMetadata: PublicKey } {
  const memberKey = publicKey(member);
  return { buffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), memberKey.toBuffer()], STOCKSTREAM_PROGRAM_KEY)[0], delegationRecord: PublicKey.findProgramAddressSync([Buffer.from("delegation"), memberKey.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID)[0], delegationMetadata: PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), memberKey.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID)[0] };
}

function commitInstruction(discriminator: number, accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.payer, true, true), accountMeta(MAGICBLOCK_MAGIC_CONTEXT_ID, false, true), accountMeta(MAGICBLOCK_MAGIC_PROGRAM_ID, false, false), ...(accounts.clusterAccounts ?? []).map((a) => accountMeta(a, false, true))]);
}
export function commitMarket(accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction { return commitInstruction(OPCODE.commitMarket, accounts, sequence); }
export function commitAndUndelegate(accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction { return commitInstruction(OPCODE.commitAndUndelegate, accounts, sequence); }
