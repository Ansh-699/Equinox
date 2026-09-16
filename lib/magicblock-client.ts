import {
  createCommitAndUndelegateInstruction,
  createCommitInstruction,
  createDelegateInstruction,
} from "@magicblock-labs/ephemeral-rollups-kit";
import { address, type Address, type Instruction } from "@solana/kit";

import { COMMIT_INTERVAL_MS, DELEGATION_PROGRAM, rejectMixedWritableDomains, validateHotCluster, type WritableAccount } from "./magicblock";

export interface MagicBlockClusterRequest {
  payer: string;
  ownerProgram: string;
  validator: string;
  hotAccounts: readonly WritableAccount[];
}

function asAddress(value: string): Address {
  return address(value);
}

/**
 * Builds the official MagicBlock SDK instructions for a complete market hot
 * cluster. This is deliberately asynchronous because the SDK derives record
 * and buffer PDAs for every delegated account.
 */
export async function buildDelegateCluster(request: MagicBlockClusterRequest): Promise<Instruction[]> {
  rejectMixedWritableDomains([...request.hotAccounts]);
  validateHotCluster([...request.hotAccounts]);
  const payer = asAddress(request.payer);
  const ownerProgram = asAddress(request.ownerProgram);
  const validator = asAddress(request.validator);
  return Promise.all(request.hotAccounts.map((account) => createDelegateInstruction({
    payer,
    delegatedAccount: asAddress(account.address),
    ownerProgram,
    validator,
  }, { commitFrequencyMs: COMMIT_INTERVAL_MS, validator })));
}

export function buildCommitCluster(payer: string, accounts: readonly WritableAccount[]): Instruction {
  rejectMixedWritableDomains([...accounts]);
  validateHotCluster([...accounts]);
  return createCommitInstruction(asAddress(payer), accounts.map((account) => asAddress(account.address)));
}

export function buildCommitAndUndelegateCluster(payer: string, accounts: readonly WritableAccount[]): Instruction {
  rejectMixedWritableDomains([...accounts]);
  validateHotCluster([...accounts]);
  return createCommitAndUndelegateInstruction(asAddress(payer), accounts.map((account) => asAddress(account.address)));
}

export function assertOfficialDelegationProgram(instruction: Instruction): void {
  if (instruction.programAddress !== DELEGATION_PROGRAM) {
    throw new Error("MagicBlock SDK returned an unexpected delegation program");
  }
}
