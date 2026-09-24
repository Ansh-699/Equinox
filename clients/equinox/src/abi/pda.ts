/**
 * Canonical PDA derivations, matching `programs/equinox/src/` exactly.
 */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

const PROGRAM_KEY = new PublicKey(PROGRAM_ID);
const DLP_KEY = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

export function deriveInstrument(instrumentId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("instrument"), Buffer.from(instrumentId)], PROGRAM_KEY)[0];
}

export function derivePerpMarket(instrument: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("perp-market"), instrument.toBuffer()], PROGRAM_KEY)[0];
}

export function deriveVault(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_KEY)[0];
}

export function deriveVaultAuthority(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_KEY)[0];
}

export function deriveSettlementScratch(market: PublicKey, seatIndex: number): PublicKey {
  const seatBytes = Buffer.alloc(2); seatBytes.writeUInt16LE(seatIndex);
  return PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), seatBytes], PROGRAM_KEY)[0];
}

export function deriveTradingSession(owner: PublicKey, market: PublicKey, seatIndex: number, sessionSigner: PublicKey): PublicKey {
  const seatBytes = Buffer.alloc(2); seatBytes.writeUInt16LE(seatIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("trading_session"), owner.toBuffer(), market.toBuffer(), seatBytes, sessionSigner.toBuffer()],
    PROGRAM_KEY,
  )[0];
}

export function deriveDelegateBuffer(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("buffer"), account.toBuffer()], PROGRAM_KEY)[0];
}

export function deriveDelegationRecord(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("delegation"), account.toBuffer()], DLP_KEY)[0];
}

export function deriveDelegationMetadata(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), account.toBuffer()], DLP_KEY)[0];
}

export function deriveUndelegateBuffer(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("undelegate-buffer"), account.toBuffer()], DLP_KEY)[0];
}
