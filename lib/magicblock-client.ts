// NOTE: this module builds top-level delegation-program instructions
// directly via the official SDK, bypassing StockStream's own program. That
// cannot actually execute on chain: the delegation program's `Delegate`
// instruction requires the delegated PDA to be a *signer*
// (`processor/fast/delegate.rs`: "This instruction is meant to be called via
// CPI with the owning program signing for the delegated account"), which
// only a CPI from the owning program (via `invoke_signed` with the PDA's own
// seeds) can satisfy -- a client cannot make a PDA sign a top-level
// transaction. The real, invocable path is
// `programs/stockstream/src/magicblock.rs::delegate_market`, driven from the
// client via `clients/stockstream/src/index.ts::delegateMarket`, which
// submits a StockStream `DelegateMarket` instruction that performs the CPI
// itself. This file is kept only because other code does not yet depend on
// it; do not wire it into a real transaction path as-is.
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
