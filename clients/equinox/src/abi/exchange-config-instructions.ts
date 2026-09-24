import { TransactionInstruction } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { checkedUnsigned, writeUnsigned } from "./encoding";
import { accountMeta, instruction, publicKey, type AddressInput } from "./transaction";
import type { RegistryAccounts } from "./registry-instructions";

export const EXCHANGE_CONFIG_FIELD = {
  pauseAuthority: 1 << 0, emergencyAuthority: 1 << 1, keeperAuthority: 1 << 2, makerFeeBps: 1 << 3, takerFeeBps: 1 << 4, liquidationFeeBps: 1 << 5,
  defaultInitialMarginBps: 1 << 6, defaultMaintenanceMarginBps: 1 << 7, defaultMaximumLeverage: 1 << 8, collateralMint: 1 << 9, oracleProgram: 1 << 10,
  insuranceTargetBalance: 1 << 11, protocolStatus: 1 << 12,
} as const;
export interface UpdateExchangeConfigFields {
  pauseAuthority?: AddressInput; emergencyAuthority?: AddressInput; keeperAuthority?: AddressInput; makerFeeBps?: number; takerFeeBps?: number; liquidationFeeBps?: number;
  defaultInitialMarginBps?: number; defaultMaintenanceMarginBps?: number; defaultMaximumLeverage?: number; collateralMint?: AddressInput; oracleProgram?: AddressInput;
  insuranceTargetBalance?: bigint | number; protocolStatus?: number;
}

export function updateExchangeConfig(accounts: RegistryAccounts, fields: UpdateExchangeConfigFields, expectedConfigSequence: bigint | number): TransactionInstruction {
  let fieldMask = 0; const data = new Uint8Array(196); data[0] = OPCODE.updateExchangeConfig;
  const writePubkeyField = (offset: number, bit: number, value: AddressInput | undefined) => { if (value === undefined) return; fieldMask |= bit; data.set(publicKey(value).toBytes(), offset); };
  const writeU16Field = (offset: number, bit: number, value: number | undefined) => { if (value === undefined) return; fieldMask |= bit; writeUnsigned(data, offset, checkedUnsigned(value, 16, "value"), 2); };
  writePubkeyField(5, EXCHANGE_CONFIG_FIELD.pauseAuthority, fields.pauseAuthority); writePubkeyField(37, EXCHANGE_CONFIG_FIELD.emergencyAuthority, fields.emergencyAuthority); writePubkeyField(69, EXCHANGE_CONFIG_FIELD.keeperAuthority, fields.keeperAuthority);
  writeU16Field(101, EXCHANGE_CONFIG_FIELD.makerFeeBps, fields.makerFeeBps); writeU16Field(103, EXCHANGE_CONFIG_FIELD.takerFeeBps, fields.takerFeeBps); writeU16Field(105, EXCHANGE_CONFIG_FIELD.liquidationFeeBps, fields.liquidationFeeBps); writeU16Field(107, EXCHANGE_CONFIG_FIELD.defaultInitialMarginBps, fields.defaultInitialMarginBps); writeU16Field(109, EXCHANGE_CONFIG_FIELD.defaultMaintenanceMarginBps, fields.defaultMaintenanceMarginBps);
  if (fields.defaultMaximumLeverage !== undefined) { fieldMask |= EXCHANGE_CONFIG_FIELD.defaultMaximumLeverage; writeUnsigned(data, 111, checkedUnsigned(fields.defaultMaximumLeverage, 32, "defaultMaximumLeverage"), 4); }
  writePubkeyField(115, EXCHANGE_CONFIG_FIELD.collateralMint, fields.collateralMint); writePubkeyField(147, EXCHANGE_CONFIG_FIELD.oracleProgram, fields.oracleProgram);
  if (fields.insuranceTargetBalance !== undefined) { fieldMask |= EXCHANGE_CONFIG_FIELD.insuranceTargetBalance; writeUnsigned(data, 179, checkedUnsigned(fields.insuranceTargetBalance, 64, "insuranceTargetBalance"), 8); }
  if (fields.protocolStatus !== undefined) { fieldMask |= EXCHANGE_CONFIG_FIELD.protocolStatus; data[187] = fields.protocolStatus; }
  writeUnsigned(data, 1, BigInt(fieldMask), 4); writeUnsigned(data, 188, checkedUnsigned(expectedConfigSequence, 64, "expectedConfigSequence"), 8);
  return instruction(data, [accountMeta(accounts.exchange, false, true), accountMeta(accounts.authority, true, false)]);
}
