/**
 * Canonical instruction opcodes and data encoders.
 * All currently assigned opcodes match `programs/equinox/src/instruction.rs`.
 */
export const OPCODE = {
  initializeMarket: 0, createTraderSeat: 1, closeTraderSeat: 2,
  placeOrder: 3, cancelOrder: 4, cancelAll: 5,
  updateFunding: 6, liquidate: 7, initializeSettlementScratch: 8,
  initializeVault: 9, depositCollateral: 10, withdrawCollateral: 11,
  consumeOracleUpdate: 12, delegateMarket: 13, commitMarket: 14,
  commitAndUndelegate: 15, undelegationCallback: 16,
  authorizeTradingSession: 17, revokeTradingSession: 18,
  initializeExchange: 19, registerStockInstrument: 20, createPerpMarket: 21,
  updateStockInstrument: 22, suspendStockInstrument: 23, updateMarketRisk: 24,
  pauseMarket: 25, resumeMarket: 26, setCloseOnly: 27,
  enterCorporateAction: 28, resolveCorporateAction: 29, closeMarket: 30,
  updateTradingSessionLimits: 31, closeTradingSession: 32,
  replaceOrder: 33, transferToInsuranceFund: 34, withdrawProtocolFees: 35,
  withdrawInsuranceFunds: 36, recordBadDebt: 37, resolveBadDebt: 38,
  reconcileVault: 39, updateExchangeConfig: 40,
  delegateClusterMember: 41, createMarketAccount: 42,
  createInstrumentAccount: 43, createVaultAccount: 44,
  createScratchAccount: 45, createV3Account: 46,
  initializeV3Market: 47,
  delegateV3Account: 48,
  createV3TraderSeat: 49,
  closeV3TraderSeat: 50,
  requestV3Undelegation: 51,
  rollbackV3Undelegation: 52,
  depositCollateralV3: 53,
  withdrawCollateralV3: 54,
  reconcileVaultV3: 55,
  createV3VaultAccount: 56,
  createV3TradingSession: 57,
  updateOracleSnapshotV3: 58,
  createOracleSnapshotV3: 59,
  depositToInboxV3: 60,
  claimInboxDepositV3: 61,
  requestWithdrawalV3: 62,
  claimWithdrawalV3: 63,
} as const;

/** Session action allowlist bits — must match `session::SESSION_ACTION_*`. */
export const SESSION_ACTION = {
  place: 1 << 0, cancel: 1 << 1, cancelAll: 1 << 2,
  replace: 1 << 3, reduceOnlyClose: 1 << 4,
  all: (1 << 5) - 1,
} as const;

/** Market modes — must match `state::MarketMode`. */
export const MARKET_MODE = { Paused: 0, Open: 1, CloseOnly: 2, Emergency: 3 } as const;

/** Delegation status — must match `state::DelegationStatus`. */
export const DELEGATION_STATUS = { NotDelegated: 0, Delegated: 1, Undelegating: 2, Restored: 3 } as const;

/** Vault reconciliation status — must match `state::ReconciliationStatus`. */
export const RECONCILIATION_STATUS = { Reconciled: 0, SurplusDetected: 1, DeficitDetected: 2, RecoveryRequired: 3 } as const;

export interface InstructionFixture { name: string; data: Uint8Array; }

/** Stable human-readable decoder used by diagnostics and ABI golden tests.
 * The opcode table remains the sole authority; unknown/truncated payloads
 * fail closed instead of inventing an instruction name. */
export function decodeInstruction(data: Uint8Array): InstructionFixture {
  if (data.length === 0) throw new RangeError("Empty instruction");
  const names: Record<number, string> = {
    [OPCODE.initializeMarket]: "InitializeMarket", [OPCODE.createTraderSeat]: "CreateTraderSeat", [OPCODE.closeTraderSeat]: "CloseTraderSeat",
    [OPCODE.placeOrder]: "PlaceOrder", [OPCODE.cancelOrder]: "CancelOrder", [OPCODE.cancelAll]: "CancelAll", [OPCODE.updateFunding]: "UpdateFunding", [OPCODE.liquidate]: "Liquidate", [OPCODE.initializeSettlementScratch]: "InitializeSettlementScratch",
    [OPCODE.initializeVault]: "InitializeVault", [OPCODE.depositCollateral]: "DepositCollateral", [OPCODE.withdrawCollateral]: "WithdrawCollateral", [OPCODE.consumeOracleUpdate]: "ConsumeOracleUpdate", [OPCODE.delegateMarket]: "DelegateMarket", [OPCODE.commitMarket]: "CommitMarket", [OPCODE.commitAndUndelegate]: "CommitAndUndelegate", [OPCODE.undelegationCallback]: "UndelegationCallback",
    [OPCODE.authorizeTradingSession]: "AuthorizeTradingSession", [OPCODE.revokeTradingSession]: "RevokeTradingSession", [OPCODE.initializeExchange]: "InitializeExchange", [OPCODE.registerStockInstrument]: "RegisterStockInstrument", [OPCODE.createPerpMarket]: "CreatePerpMarket", [OPCODE.updateStockInstrument]: "UpdateStockInstrument", [OPCODE.suspendStockInstrument]: "SuspendStockInstrument", [OPCODE.updateMarketRisk]: "UpdateMarketRisk", [OPCODE.pauseMarket]: "PauseMarket", [OPCODE.resumeMarket]: "ResumeMarket", [OPCODE.setCloseOnly]: "SetCloseOnly", [OPCODE.enterCorporateAction]: "EnterCorporateAction", [OPCODE.resolveCorporateAction]: "ResolveCorporateAction", [OPCODE.closeMarket]: "CloseMarket", [OPCODE.updateTradingSessionLimits]: "UpdateTradingSessionLimits", [OPCODE.closeTradingSession]: "CloseTradingSession", [OPCODE.replaceOrder]: "ReplaceOrder",
    [OPCODE.transferToInsuranceFund]: "TransferToInsuranceFund", [OPCODE.withdrawProtocolFees]: "WithdrawProtocolFees", [OPCODE.withdrawInsuranceFunds]: "WithdrawInsuranceFunds", [OPCODE.recordBadDebt]: "RecordBadDebt", [OPCODE.resolveBadDebt]: "ResolveBadDebt", [OPCODE.reconcileVault]: "ReconcileVault", [OPCODE.updateExchangeConfig]: "UpdateExchangeConfig", [OPCODE.delegateClusterMember]: "DelegateClusterMember", [OPCODE.createMarketAccount]: "CreateMarketAccount", [OPCODE.createInstrumentAccount]: "CreateInstrumentAccount", [OPCODE.createVaultAccount]: "CreateVaultAccount", [OPCODE.createScratchAccount]: "CreateScratchAccount",
    [OPCODE.createV3Account]: "CreateV3Account", [OPCODE.initializeV3Market]: "InitializeV3Market", [OPCODE.delegateV3Account]: "DelegateV3Account", [OPCODE.createV3TraderSeat]: "CreateV3TraderSeat", [OPCODE.closeV3TraderSeat]: "CloseV3TraderSeat", [OPCODE.requestV3Undelegation]: "RequestV3Undelegation", [OPCODE.rollbackV3Undelegation]: "RollbackV3Undelegation", [OPCODE.depositCollateralV3]: "DepositCollateralV3", [OPCODE.withdrawCollateralV3]: "WithdrawCollateralV3",
    [OPCODE.updateOracleSnapshotV3]: "UpdateOracleSnapshotV3",
    [OPCODE.createOracleSnapshotV3]: "CreateOracleSnapshotV3",
  };
  const name = names[data[0]];
  if (!name) throw new RangeError("Unknown instruction");
  return { name, data: data.slice() };
}
