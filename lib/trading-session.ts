export type SessionAction = "place" | "cancel" | "replace" | "cancel_all" | "reduce_only_close";
export const ALLOWED_ACTIONS: readonly SessionAction[] = ["place", "cancel", "replace", "cancel_all", "reduce_only_close"];
export interface TradingSession { owner: string; signer: string; programId: string; market: string; seat: number; expiresAt: number; actions: readonly SessionAction[]; maxOrderNotional: bigint; maxExposure: bigint; maxOpenOrders: number; nonce: bigint; revoked: boolean; }
export function authorize(session: TradingSession, input: { signer: string; programId: string; market: string; seat: number; action: SessionAction; notional: bigint; exposure: bigint; openOrders: number; nonce: bigint; now: number }): void {
  if (session.revoked || input.now >= session.expiresAt) throw new Error("session expired or revoked");
  if (input.signer !== session.signer || input.programId !== session.programId || input.market !== session.market || input.seat !== session.seat) throw new Error("session binding mismatch");
  if (!session.actions.includes(input.action) || !ALLOWED_ACTIONS.includes(input.action)) throw new Error("session action forbidden");
  if (input.notional > session.maxOrderNotional || input.exposure > session.maxExposure || input.openOrders > session.maxOpenOrders) throw new Error("session risk limit exceeded");
  if (input.nonce !== session.nonce) throw new Error("session nonce replay");
}
