import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { checkedUnsigned, writeSigned, writeUnsigned } from "./encoding";
import { accountMeta, instruction, publicKey, EQUINOX_PROGRAM_KEY, type AddressInput } from "./transaction";

export interface TradingSessionAccounts { market: AddressInput; authority: AddressInput; sessionSigner: AddressInput; payer: AddressInput; }
export interface SessionControlAccounts { market: AddressInput; authority: AddressInput; session: AddressInput; sessionSigner: AddressInput; }
export interface TradingSessionPolicy { seatIndex: number; actions: number; maxOrderNotional: bigint | number; maxCumulativeNotional: bigint | number; maximumExposure: bigint | number; maximumOpenOrders: number; }

export const SESSION_ACTION = {
  place: 1 << 0, cancel: 1 << 1, cancelAll: 1 << 2,
  replace: 1 << 3, reduceOnlyClose: 1 << 4,
} as const;

export function deriveTradingSession(owner: AddressInput, market: AddressInput, seatIndex: number, sessionSigner: AddressInput): PublicKey {
  const seatIndexBytes = new Uint8Array(2);
  new DataView(seatIndexBytes.buffer).setUint16(0, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true);
  return PublicKey.findProgramAddressSync([
    Buffer.from("trading_session"), publicKey(owner).toBuffer(), publicKey(market).toBuffer(), Buffer.from(seatIndexBytes), publicKey(sessionSigner).toBuffer(),
  ], EQUINOX_PROGRAM_KEY)[0];
}

function sessionLimitsInstruction(discriminator: number, accounts: [AddressInput, boolean, boolean][], expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  if (!Number.isInteger(policy.seatIndex) || policy.seatIndex < 0 || policy.seatIndex > 0xffff || !Number.isInteger(policy.actions) || policy.actions <= 0 || policy.actions > 0xff || !Number.isInteger(policy.maximumOpenOrders) || policy.maximumOpenOrders <= 0 || policy.maximumOpenOrders > 0xffff) throw new RangeError("invalid trading session policy");
  const maxOrder = checkedUnsigned(policy.maxOrderNotional, 64, "maxOrderNotional");
  const maxCumulative = checkedUnsigned(policy.maxCumulativeNotional, 64, "maxCumulativeNotional");
  const maximumExposure = BigInt(policy.maximumExposure);
  if (maxOrder === 0n || maxCumulative < maxOrder || maximumExposure <= 0n || maximumExposure >= 2n ** 127n) throw new RangeError("invalid trading session limits");
  const data = new Uint8Array(46); const view = new DataView(data.buffer);
  data[0] = discriminator; view.setUint16(1, policy.seatIndex, true); writeUnsigned(data, 3, checkedUnsigned(expiresAt, 64, "expiresAt"), 8);
  data[11] = policy.actions; writeUnsigned(data, 12, maxOrder, 8); writeUnsigned(data, 20, maxCumulative, 8); writeSigned(data, 28, maximumExposure, 16); view.setUint16(44, policy.maximumOpenOrders, true);
  return instruction(data, accounts.map(([address, isSigner, isWritable]) => accountMeta(address, isSigner, isWritable)));
}

export function authorizeTradingSession(accounts: TradingSessionAccounts, expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  return sessionLimitsInstruction(OPCODE.authorizeTradingSession, [
    [accounts.market, false, true], [accounts.payer, true, true],
    [deriveTradingSession(accounts.authority, accounts.market, policy.seatIndex, accounts.sessionSigner), false, true],
    [accounts.sessionSigner, false, false], [SystemProgram.programId, false, false],
  ], expiresAt, policy);
}

export function updateTradingSessionLimits(accounts: SessionControlAccounts, expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  return sessionLimitsInstruction(OPCODE.updateTradingSessionLimits, [
    [accounts.market, false, true], [accounts.authority, true, false], [accounts.session, false, true], [accounts.sessionSigner, false, false],
  ], expiresAt, policy);
}

export function revokeTradingSession(accounts: SessionControlAccounts, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = OPCODE.revokeTradingSession; new DataView(data.buffer).setUint16(1, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.session, false, true), accountMeta(accounts.sessionSigner, false, false)]);
}

export function closeTradingSession(accounts: SessionControlAccounts, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = OPCODE.closeTradingSession; new DataView(data.buffer).setUint16(1, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, true), accountMeta(accounts.session, false, true), accountMeta(accounts.sessionSigner, false, false)]);
}
