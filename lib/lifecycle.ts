export type ExecutionPhase =
  | "read_only"
  | "deposit_pending"
  | "funded_l1"
  | "session_pending"
  | "delegated"
  | "commit_pending"
  | "undelegating"
  | "withdraw_ready"
  | "error";

export type LifecycleEvent =
  | "REQUEST_DEPOSIT"
  | "CONFIRM_DEPOSIT"
  | "REQUEST_SESSION"
  | "CONFIRM_DELEGATION"
  | "REQUEST_COMMIT"
  | "COMMIT_CONFIRMED"
  | "REQUEST_UNDELEGATE"
  | "UNDELEGATED"
  | "WITHDRAW"
  | "FAIL"
  | "RESET";

export interface ExecutionState {
  phase: ExecutionPhase;
  l1Sequence: number;
  erSequence: number;
  sessionExpiresAt?: number;
  error?: string;
}

export const initialExecutionState: ExecutionState = {
  phase: "read_only",
  l1Sequence: 0,
  erSequence: 0
};

export function transition(state: ExecutionState, event: LifecycleEvent): ExecutionState {
  switch (event) {
    case "REQUEST_DEPOSIT":
      return state.phase === "read_only" ? { ...state, phase: "deposit_pending" } : state;
    case "CONFIRM_DEPOSIT":
      return state.phase === "deposit_pending" ? { ...state, phase: "funded_l1", l1Sequence: state.l1Sequence + 1 } : state;
    case "REQUEST_SESSION":
      return state.phase === "funded_l1" ? { ...state, phase: "session_pending" } : state;
    case "CONFIRM_DELEGATION":
      return state.phase === "session_pending"
        ? { ...state, phase: "delegated", erSequence: state.erSequence + 1, sessionExpiresAt: Date.now() + 15 * 60_000 }
        : state;
    case "REQUEST_COMMIT":
      return state.phase === "delegated" ? { ...state, phase: "commit_pending" } : state;
    case "COMMIT_CONFIRMED":
      return state.phase === "commit_pending"
        ? { ...state, phase: "delegated", l1Sequence: state.erSequence }
        : state;
    case "REQUEST_UNDELEGATE":
      return state.phase === "delegated" ? { ...state, phase: "undelegating" } : state;
    case "UNDELEGATED":
      return state.phase === "undelegating"
        ? { ...state, phase: "withdraw_ready", l1Sequence: state.erSequence, sessionExpiresAt: undefined }
        : state;
    case "WITHDRAW":
      return state.phase === "withdraw_ready" ? { ...initialExecutionState, l1Sequence: state.l1Sequence + 1, erSequence: state.erSequence + 1 } : state;
    case "FAIL":
      return { ...state, phase: "error", error: "Transaction did not reach a confirmed state. Review the signed transaction before retrying." };
    case "RESET":
      return initialExecutionState;
    default:
      return state;
  }
}

export const phaseLabel: Record<ExecutionPhase, string> = {
  read_only: "Read-only",
  deposit_pending: "Awaiting L1 deposit",
  funded_l1: "L1 collateral available",
  session_pending: "Awaiting session approval",
  delegated: "ER trading session active",
  commit_pending: "Commit pending",
  undelegating: "Committing and undelegating",
  withdraw_ready: "L1 withdrawal ready",
  error: "Action needs review"
};
