import { createV3TraderSeat, decodeOracleSnapshotV3, deriveV3ExecutionAccounts } from "@/clients/equinox/src";
import type { ActiveWalletSigner } from "@/components/wallet-signer-context";
import { resolveCustodyAccounts } from "@/features/collateral/custody-accounts";
import { rollupDeposit } from "@/features/collateral/rollup-deposit";
import { firstFreeSeat } from "@/features/trading/rollup-seat";
import type { SeatPosition } from "@/features/trading/use-v3-book";
import { buildV3OrderInstructions } from "@/features/trading/v3-order";
import { createEquinoxProtocol } from "@/features/wallet/use-equinox-protocol";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { marketForSymbol } from "@/lib/markets";
import { fetchV3Aggregate } from "@/lib/v3-aggregate";
import { v3MarketFor, type V3Market } from "@/lib/v3-markets";

export interface Basket { id: string; name: string; blurb: string; legs: readonly { symbol: string; weight: number }[] }

/** Equal-weight baskets of pre-IPO perps. */
export const BASKETS: readonly Basket[] = [
  { id: "ai", name: "AI labs", blurb: "OpenAI and Anthropic, half each.", legs: [{ symbol: "OPENAI-PERP", weight: 0.5 }, { symbol: "ANTHROPIC-PERP", weight: 0.5 }] },
  { id: "frontier", name: "Frontier", blurb: "OpenAI, Anthropic and SpaceX, a third each.", legs: [{ symbol: "OPENAI-PERP", weight: 1 / 3 }, { symbol: "ANTHROPIC-PERP", weight: 1 / 3 }, { symbol: "SPACEX-PERP", weight: 1 / 3 }] },
];

export interface LegResult { symbol: string; quantity: bigint; price: number; ms: number; signature?: string }
/** A leg as it will trade: whole shares at the current price, and the margin it needs. */
export interface LegPlan { market: V3Market; price: number; quantity: bigint; marginUsd: number }

/** Margin for `quantity` shares at `leverage`, plus 10% headroom for the fill price. */
export const marginFor = (quantity: bigint, price: number, leverage: number) => (Number(quantity) * price / leverage) * 1.1;

/** Whole shares for a dollar amount (at least one). */
export function sharesFor(notionalUsd: number, priceUsd: number): bigint {
  return BigInt(Math.max(1, Math.floor(notionalUsd / priceUsd)));
}

const preview = (name: string, ix: { programId: { toBase58(): string }; keys: readonly { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[] }): TransactionPreview => ({
  instruction: name, programId: ix.programId.toBase58(), status: "constructed",
  accounts: ix.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
});

/** Every leg priced and sized before anything trades (whole shares, at least one each). */
export async function planBasket(basket: Basket, notionalUsd: number, leverage: number, rpc: { accountBytes(address: string): Promise<Uint8Array> }): Promise<LegPlan[]> {
  return Promise.all(basket.legs.map(async (leg) => {
    const market = v3MarketFor(leg.symbol);
    const price = Number(decodeOracleSnapshotV3(await rpc.accountBytes(market.oracleSnapshot)).price) / 1e5;
    const quantity = sharesFor(notionalUsd * leg.weight, price);
    return { market, price, quantity, marginUsd: marginFor(quantity, price, leverage) };
  }));
}

/** One leg: seat if missing, margin if short, then a market (IOC) order. All
 * signed by the trading key, so the whole basket needs no wallet prompt. */
async function tradeLeg(plan: LegPlan, side: "long" | "short", leverage: number, signer: ActiveWalletSigner, report: (message: string) => void): Promise<LegResult> {
  const { market, quantity } = plan;
  const wallet = signer.address!;
  const protocol = createEquinoxProtocol(signer, market.core, market);
  if (!protocol) throw new Error("no signer");
  const execution = deriveV3ExecutionAccounts(market.core, wallet);
  const writable = [market.core, ...execution.bookPages, ...execution.seatShards, ...execution.eventShards].map(String);

  const [aggregate, snapshotBytes] = await Promise.all([fetchV3Aggregate(market.core), protocol.rpc.accountBytes(market.oracleSnapshot)]);
  const positions = ((aggregate as { positions?: SeatPosition[] } | null)?.positions ?? []);
  const own = positions.find((p) => p.trader === wallet);
  const seatIndex = own ? own.shard * 32 + own.slot : firstFreeSeat(positions);
  const snapshot = decodeOracleSnapshotV3(snapshotBytes);
  const price = Number(snapshot.price) / 1e5;

  if (!own) {
    report(`${market.symbol}: opening your margin account…`);
    const seat = createV3TraderSeat({ core: market.core, seatShards: execution.seatShards, eventShards: execution.eventShards, trader: wallet }, seatIndex);
    await protocol.service.executeEr(preview("CreateV3TraderSeat", seat), [seat], [market.core, ...execution.seatShards, ...execution.eventShards].map(String));
  }
  // Isolated margin per market: top the seat up to what this leg needs (+10%).
  const margin = BigInt(Math.ceil(marginFor(quantity, price, leverage) * 1e6));
  const available = own ? BigInt(own.availableCollateral) : 0n;
  if (available < margin) {
    const accounts = resolveCustodyAccounts(wallet, market.core, marketForSymbol("TSLA-PERP"), seatIndex, market);
    if (!accounts) throw new Error("custody accounts unavailable");
    report(`${market.symbol}: depositing ${(Number(margin - available) / 1e6).toFixed(2)} USDC margin…`);
    await rollupDeposit(protocol, accounts, margin - available);
  }
  const built = buildV3OrderInstructions({
    core: market.core, wallet, oracleSnapshot: market.oracleSnapshot, seatIndex,
    side: side === "long" ? "bid" : "ask", orderType: "ioc", reduceOnly: false, quantity,
    // A market order: crosses up to 2% through the price.
    limitPriceUsd: (price * (side === "long" ? 1.02 : 0.98)).toFixed(2), expiresInMinutes: 0, oracleClock: snapshot.publishTimestamp,
  });
  if ("error" in built) throw new Error(built.error);
  report(`${market.symbol}: ${side === "long" ? "buying" : "selling"} ${quantity}…`);
  const started = performance.now();
  const result = await protocol.service.executeEr(preview("PlaceOrder", built.instructions[1]), built.instructions, writable);
  return { symbol: market.symbol, quantity, price, ms: Math.round(performance.now() - started), signature: result.signature };
}

/** Trades every planned leg (in parallel: separate markets, separate seats). */
export async function tradeBasket(plan: readonly LegPlan[], side: "long" | "short", leverage: number, signer: ActiveWalletSigner, report: (message: string) => void): Promise<LegResult[]> {
  return Promise.all(plan.map((leg) => tradeLeg(leg, side, leverage, signer, report)));
}
