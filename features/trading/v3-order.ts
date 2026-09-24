import { ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import { deriveV3ExecutionAccounts, placeOrderV3 } from "@/clients/stockstream/src";

/** V3 prices use the oracle's raw scale: USD × 10^-exponent (TSLA exponent −5). */
export function usdToRawPrice(usd: string, exponent = -5): bigint | null {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * 10 ** -exponent));
}

/** GTC orders still need an expiry after the oracle clock; 30 days is effectively GTC. */
export const GTC_SECONDS = 60 * 60 * 24 * 30;

export interface V3OrderInput {
  core: string; wallet: string; oracleSnapshot: string; seatIndex: number;
  side: "bid" | "ask"; orderType: string; reduceOnly: boolean;
  quantity: bigint; limitPriceUsd: string; expiresInMinutes: number; oracleClock: bigint;
}

let lastClientOrderId = 0n;
/** Unique per order even for several clicks in one millisecond (two identical
 * orders under one blockhash would otherwise be the same transaction). */
function nextClientOrderId(): bigint {
  const now = BigInt(Date.now()) * 1_000n;
  lastClientOrderId = now > lastClientOrderId ? now : lastClientOrderId + 1n;
  return lastClientOrderId;
}

/** A crossing fill needs ~200k compute units, so every V3 order raises the limit. */
export function buildV3OrderInstructions(input: V3OrderInput): { instructions: TransactionInstruction[]; writableAccounts: string[] } | { error: string } {
  if (input.quantity <= 0n) return { error: "Enter a size above zero." };
  const price = usdToRawPrice(input.limitPriceUsd);
  if (price === null) return { error: "Enter a limit price in USD." };
  const execution = { ...deriveV3ExecutionAccounts(input.core, input.wallet), oracleSnapshot: input.oracleSnapshot };
  const expiresAt = input.oracleClock + BigInt(input.expiresInMinutes > 0 ? input.expiresInMinutes * 60 : GTC_SECONDS);
  const order = placeOrderV3({
    ...execution, seatIndex: input.seatIndex, side: input.side, tree: "fixed", quantity: input.quantity, priceOrOffset: price,
    expiresAt, clientOrderId: nextClientOrderId(), postOnly: input.orderType === "post-only",
    immediateOrCancel: input.orderType === "ioc", reduceOnly: input.reduceOnly,
  });
  const writableAccounts = [execution.core, ...execution.bookPages, ...execution.seatShards, ...execution.eventShards].map(String);
  return { instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), order], writableAccounts };
}
