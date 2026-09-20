import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { STOCKSTREAM_PROGRAM_ID } from "../constants";
import { OPCODE } from "./instructions";
import { checkedUnsigned, writeUnsigned } from "./encoding";
import { accountMeta, instruction, type AddressInput } from "./transaction";

export interface VaultAccounts { market: AddressInput; authority: AddressInput; mint: AddressInput; tokenProgram: AddressInput; vault: AddressInput; vaultAuthority: AddressInput; }
export interface CustodyAccounts extends VaultAccounts { seatIndex: number; sourceOrDestination: AddressInput; }
export interface InsuranceTransferAccounts { market: AddressInput; authority: AddressInput; }
/** `authority` is the market authority for protocol fees and emergency authority for insurance funds. */
export interface LedgerWithdrawalAccounts { market: AddressInput; authority: AddressInput; vault: AddressInput; vaultAuthority: AddressInput; destination: AddressInput; mint: AddressInput; tokenProgram: AddressInput; }
export interface BadDebtAccounts { market: AddressInput; authority: AddressInput; }
export interface ReconcileAccounts { market: AddressInput; vault: AddressInput; mint: AddressInput; tokenProgram: AddressInput; }

export function initializeVault(accounts: VaultAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(OPCODE.initializeVault), [
    accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.mint, false, false),
    accountMeta(accounts.tokenProgram, false, false), accountMeta(accounts.vault, false, true), accountMeta(accounts.vaultAuthority, false, false),
  ]);
}

function amountInstruction(discriminator: number, accounts: CustodyAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(accounts.seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.vault, false, true), accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false)]);
}
export function depositCollateral(accounts: CustodyAccounts, amount: bigint | number): TransactionInstruction { return amountInstruction(OPCODE.depositCollateral, accounts, amount); }
export function withdrawCollateral(accounts: CustodyAccounts, amount: bigint | number): TransactionInstruction {
  const result = amountInstruction(OPCODE.withdrawCollateral, accounts, amount);
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), new PublicKey(accounts.market).toBuffer()], new PublicKey(STOCKSTREAM_PROGRAM_ID))[0];
  result.keys = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.mint, false, false), accountMeta(accounts.vault, false, true), accountMeta(vaultAuthority, false, false), accountMeta(accounts.tokenProgram, false, false)];
  return result;
}

export function transferToInsuranceFund(accounts: InsuranceTransferAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = OPCODE.transferToInsuranceFund; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

function ledgerWithdrawal(discriminator: number, accounts: LedgerWithdrawalAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.vault, false, true), accountMeta(accounts.vaultAuthority, false, false), accountMeta(accounts.destination, false, true), accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false)]);
}
export function withdrawProtocolFees(accounts: LedgerWithdrawalAccounts, amount: bigint | number): TransactionInstruction { return ledgerWithdrawal(OPCODE.withdrawProtocolFees, accounts, amount); }
export function withdrawInsuranceFunds(accounts: LedgerWithdrawalAccounts, amount: bigint | number): TransactionInstruction { return ledgerWithdrawal(OPCODE.withdrawInsuranceFunds, accounts, amount); }

export function recordBadDebt(accounts: BadDebtAccounts, seatIndex: number, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = OPCODE.recordBadDebt; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}
export function resolveBadDebt(accounts: BadDebtAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = OPCODE.resolveBadDebt; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}
export function reconcileVault(accounts: ReconcileAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(OPCODE.reconcileVault), [accountMeta(accounts.market, false, true), accountMeta(accounts.vault, false, false), accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false)]);
}
