/** Devnet onboarding faucet: test collateral (the keeper holds the test
 * mint's authority) plus a small SOL top-up for fees and rent. */
import { AccountRole, address, getAddressEncoder, getBase58Encoder, getProgramDerivedAddress, type Instruction } from "@solana/kit";

export const FAUCET_TOKENS = 1_000_000_000n; // 1,000 test tokens (6 decimals)
export const FAUCET_LAMPORTS = 50_000_000n; // 0.05 SOL
export const SOL_TOP_UP_BELOW = 20_000_000n; // only wallets under 0.02 SOL get SOL
export const CLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export async function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [encoder.encode(address(owner)), encoder.encode(address(TOKEN_PROGRAM)), encoder.encode(address(mint))],
  });
  return ata;
}

const u64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; };
const meta = (value: string, role: AccountRole) => ({ address: address(value), role });

export async function faucetInstructions(keeper: string, wallet: string, mint: string, sendSol: boolean, tokens: bigint = FAUCET_TOKENS): Promise<Instruction[]> {
  const ata = await associatedTokenAddress(wallet, mint);
  const instructions: Instruction[] = [
    // CreateIdempotent: a returning wallet keeps its existing account.
    { programAddress: address(ATA_PROGRAM), accounts: [meta(keeper, AccountRole.WRITABLE_SIGNER), meta(ata, AccountRole.WRITABLE), meta(wallet, AccountRole.READONLY), meta(mint, AccountRole.READONLY), meta(SYSTEM_PROGRAM, AccountRole.READONLY), meta(TOKEN_PROGRAM, AccountRole.READONLY)], data: Uint8Array.of(1) },
    { programAddress: address(TOKEN_PROGRAM), accounts: [meta(mint, AccountRole.WRITABLE), meta(ata, AccountRole.WRITABLE), meta(keeper, AccountRole.READONLY_SIGNER)], data: Uint8Array.of(7, ...u64(tokens)) },
  ];
  if (sendSol) instructions.push({ programAddress: address(SYSTEM_PROGRAM), accounts: [meta(keeper, AccountRole.WRITABLE_SIGNER), meta(wallet, AccountRole.WRITABLE)], data: Uint8Array.of(2, 0, 0, 0, ...u64(FAUCET_LAMPORTS)) });
  return instructions;
}

/** Message a browser wallet signs to claim test funds without a Privy session. */
export function faucetClaimMessage(wallet: string, issuedAt: number): string {
  return `StockStream devnet faucet\nwallet: ${wallet}\nissued: ${issuedAt}`;
}

/** Verifies a wallet-signed faucet claim: exact message, fresh (5 min), valid Ed25519 signature. */
export async function verifyFaucetSignature(wallet: string, message: string, signatureBase64: string, nowSeconds: number): Promise<boolean> {
  const issued = Number(/\nissued: (\d+)$/.exec(message)?.[1]);
  if (!Number.isFinite(issued) || message !== faucetClaimMessage(wallet, issued) || Math.abs(nowSeconds - issued) > 300) return false;
  try {
    const publicKey = getBase58Encoder().encode(wallet);
    const signature = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}
