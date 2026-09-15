import { createHash } from "node:crypto";

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const VAULT_SEED = "vault";
export const VAULT_AUTHORITY_SEED = "vault-authority";

export interface CustodyConfig { mint: string; decimals: number; tokenProgram: string; }
export interface TokenAccount { address: string; owner: string; mint: string; tokenProgram: string; amount: bigint; }
export interface CustodyLedger { available: bigint; reserved: bigint; fees: bigint; insurance: bigint; }

const digest = (parts: string[]) => createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 44);
export const deriveVault = (programId: string, market: string) => digest([programId, VAULT_SEED, market]);
export const deriveVaultAuthority = (programId: string, market: string) => digest([programId, VAULT_AUTHORITY_SEED, market]);

export function validateTokenAccount(account: TokenAccount, expected: CustodyConfig, owner: string): void {
  if (account.owner !== owner) throw new Error("token account owner mismatch");
  if (account.mint !== expected.mint) throw new Error("collateral mint mismatch");
  if (account.tokenProgram !== expected.tokenProgram || expected.tokenProgram !== SPL_TOKEN_PROGRAM) throw new Error("unsupported token program");
}
export function deposit(ledger: CustodyLedger, account: TokenAccount, amount: bigint, config: CustodyConfig, owner: string): CustodyLedger {
  if (amount <= 0n || account.amount < amount) throw new Error("insufficient token balance");
  validateTokenAccount(account, config, owner);
  return { ...ledger, available: ledger.available + amount };
}
export function withdraw(ledger: CustodyLedger, amount: bigint): CustodyLedger {
  if (amount <= 0n || amount > ledger.available || ledger.available - amount < ledger.reserved) throw new Error("withdrawal would make account unhealthy");
  return { ...ledger, available: ledger.available - amount };
}

export function tokenTransferMeta(source: string, destination: string, authority: string, tokenProgram = SPL_TOKEN_PROGRAM) {
  if (tokenProgram !== SPL_TOKEN_PROGRAM) throw new Error("unsupported token program");
  return [source, destination, authority, tokenProgram] as const;
}
