import type { TransactionInstruction } from "@solana/web3.js";
import { cancelAll, cancelOrder, createTraderSeat, depositCollateral, initializeSettlementScratch, placeOrder, withdrawCollateral, type CustodyAccounts, type InstructionAccounts, type PlaceOrderParams } from "../clients/equinox/src";
import type { L1Transport, RouterBoundary, TransactionPreview, WalletBoundary } from "./execution-boundary";
import { executeL1, submitEr } from "./execution-boundary";
import type { OracleFreshness } from "./oracle-freshness";

export interface ProtocolBuildContext {
  market: InstructionAccounts["market"];
  authority: InstructionAccounts["authority"];
  settlementScratch: CustodyAccounts["sourceOrDestination"];
  seatIndex: number;
}

export interface ProtocolTransport {
  encode(instructions: readonly TransactionInstruction[], blockhash?: string): Promise<Uint8Array>;
  l1: L1Transport;
  er: RouterBoundary;
  wallet: WalletBoundary;
  /** Present for V3 markets whose program requires a fresh oracle snapshot. */
  freshOracle?: OracleFreshness;
}

export class EquinoxProtocolService {
  constructor(private readonly transport: ProtocolTransport) {}

  buildSeatAndScratch(context: ProtocolBuildContext): TransactionInstruction[] {
    return [
      createTraderSeat({ market: context.market, authority: context.authority }, context.seatIndex),
      initializeSettlementScratch({ market: context.market, authority: context.authority, settlementScratch: context.settlementScratch }, context.seatIndex),
    ];
  }

  buildPlace(params: PlaceOrderParams): TransactionInstruction { return placeOrder(params); }
  buildCancel(context: ProtocolBuildContext, key: bigint): TransactionInstruction { return cancelOrder({ market: context.market, authority: context.authority }, context.seatIndex, key); }
  buildCancelAll(context: ProtocolBuildContext, limit: number): TransactionInstruction { return cancelAll({ market: context.market, authority: context.authority }, context.seatIndex, limit); }
  buildDeposit(accounts: CustodyAccounts, amount: bigint): TransactionInstruction { return depositCollateral(accounts, amount); }
  buildWithdraw(accounts: CustodyAccounts, amount: bigint): TransactionInstruction { return withdrawCollateral(accounts, amount); }

  /** `freshOracle` for writes whose on-chain checks read the oracle (custody, sessions). */
  async executeL1(preview: TransactionPreview, instructions: readonly TransactionInstruction[], options: { freshOracle?: boolean } = {}): Promise<{ preview: TransactionPreview; signature: string; confirmation: "confirmed" | "finalized" }> {
    const bytes = await this.transport.encode(instructions);
    const fresh = options.freshOracle && this.transport.freshOracle ? () => this.transport.freshOracle!.l1() : undefined;
    return executeL1(preview, this.transport.wallet, this.transport.l1, bytes, fresh);
  }

  /** Pre-fetches what an order needs (blockhash, price age) so a click only signs and sends. */
  warm(writableAccounts: readonly string[]): void {
    this.transport.er.warm?.(writableAccounts);
    this.transport.freshOracle?.warm();
  }

  /** `oracle: "best-effort"` for writes that must not depend on a live price
   * (withdrawals): refresh when possible, never fail because it could not. */
  async executeEr(preview: TransactionPreview, instructions: readonly TransactionInstruction[], writableAccounts: readonly string[], options: { oracle?: "required" | "best-effort" } = {}): Promise<{ preview: TransactionPreview; sequence: bigint; signature?: string }> {
    const refresh = () => options.oracle === "best-effort" ? this.transport.freshOracle?.er().catch(() => undefined) : this.transport.freshOracle?.er();
    // Blockhash and price freshness in parallel: both are rollup round trips.
    const [blockhash] = await Promise.all([this.transport.er.getAccountAwareBlockhash(writableAccounts), refresh()]);
    const bytes = await this.transport.encode(instructions, blockhash);
    const signingStarted = Date.now();
    const signed = await this.transport.wallet.signTransaction(bytes);
    // A slow wallet prompt can outlast the price: the rollup must see one under 10 seconds old.
    if (Date.now() - signingStarted > 2_000) await refresh();
    return submitEr(preview, this.transport.er, signed);
  }
}
