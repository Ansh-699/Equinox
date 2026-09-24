import type { CustodyAccounts, V3DepositAccounts, V3WithdrawAccounts } from "@/clients/equinox/src";
import type { PerpMarketConfig } from "@/lib/markets";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";
import { deriveV3ExecutionAccounts } from "@/clients/equinox/src";
import { PublicKey } from "@solana/web3.js";
import deployment from "@/config/equinox-deployment.json";
import type { V3Market } from "@/lib/v3-markets";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const coreSeedAddress = (seed: string, core: string) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(core).toBuffer()], new PublicKey(deployment.programId))[0].toBase58();

export type ResolvedCustodyAccounts = CustodyAccounts & {
  v3?: { deposit: V3DepositAccounts; withdraw: V3WithdrawAccounts };
};

/** Shared by deposit/withdraw everywhere they're offered (trade terminal,
 * portfolio) so there is exactly one place that resolves these accounts --
 * no duplicate PDA/ATA derivation scattered across pages. */
export function resolveCustodyAccounts(walletAddress: string | null, marketAddress: string | null, marketConfig: PerpMarketConfig, seatIndex = 0, market?: V3Market): ResolvedCustodyAccounts | null {
  if (!walletAddress || !marketAddress) return null;
  const v3Core = market?.core ?? process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
  // Every manifest market shares the collateral mint; its core derives vault and authority.
  const manifestMarket = !!v3Core && (!!market || v3Core === deployment.core);
  const mint = process.env.NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT ?? (manifestMarket ? deployment.collateralMint ?? undefined : undefined);
  const tokenProgram = process.env.NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM ?? (manifestMarket ? TOKEN_PROGRAM : undefined);
  const vault = process.env.NEXT_PUBLIC_EQUINOX_VAULT ?? (manifestMarket ? coreSeedAddress("vault", v3Core) : marketConfig.vaultPda);
  const vaultAuthority = process.env.NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY ?? (manifestMarket ? coreSeedAddress("vault-authority", v3Core) : undefined);
  if (!mint || !tokenProgram || !vault || !vaultAuthority) return null;
  const sourceOrDestination = deriveCollateralTokenAccount(walletAddress, mint, tokenProgram);
  const legacy = { market: marketAddress, authority: walletAddress, seatIndex, sourceOrDestination, mint, tokenProgram, vault, vaultAuthority } satisfies CustodyAccounts;
  if (!v3Core) return legacy;
  const snapshot = market?.oracleSnapshot ?? (v3Core === deployment.core ? deployment.oracleSnapshot : undefined);
  const oracleSnapshot = manifestMarket && snapshot ? { oracleSnapshot: snapshot } : {};
  const execution = deriveV3ExecutionAccounts(v3Core, walletAddress);
  const v3 = {
    deposit: { core: v3Core, seatShard: execution.seatShards[Math.floor(seatIndex / 32)], eventShards: execution.eventShards, authority: walletAddress, source: sourceOrDestination, vault, mint, tokenProgram, ...oracleSnapshot },
    withdraw: { ...execution, destination: sourceOrDestination, mint, vault, vaultAuthority, tokenProgram, ...oracleSnapshot },
  } satisfies { deposit: V3DepositAccounts; withdraw: V3WithdrawAccounts };
  return { ...legacy, v3 };
}
