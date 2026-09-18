import type { TransactionInstruction } from "@solana/web3.js";
import { cancelAll, cancelOrder, createTraderSeat, depositCollateral, initializeSettlementScratch, placeOrder, withdrawCollateral, type CustodyAccounts, type InstructionAccounts, type PlaceOrderParams } from "../clients/stockstream/src";
import type { L1Transport, RouterBoundary, TransactionPreview, WalletBoundary } from "./execution-boundary";
import { executeL1, submitEr } from "./execution-boundary";

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
}

export class StockStreamProtocolService {
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

  async executeL1(preview: TransactionPreview, instructions: readonly TransactionInstruction[]): Promise<{ preview: TransactionPreview; signature: string; confirmation: "confirmed" | "finalized" }> {
    const bytes = await this.transport.encode(instructions);
    return executeL1(preview, this.transport.wallet, this.transport.l1, bytes);
  }

  async executeEr(preview: TransactionPreview, instructions: readonly TransactionInstruction[], writableAccounts: readonly string[]): Promise<{ preview: TransactionPreview; sequence: bigint }> {
    const blockhash = await this.transport.er.getAccountAwareBlockhash(writableAccounts);
    const bytes = await this.transport.encode(instructions, blockhash);
    const signed = await this.transport.wallet.signTransaction(bytes);
    return submitEr(preview, this.transport.er, signed);
  }
}
