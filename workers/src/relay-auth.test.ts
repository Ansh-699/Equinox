import { describe, expect, it } from "vitest";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import {
  deriveTradingSessionAddress,
  requiredSessionActions,
  SESSION_ACTION,
  verifyPrivyToken,
  verifyTradingSession,
  type PrivyVerifier,
} from "./relay-auth";

const APP_ID = "app-123";
const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MARKET_ACCOUNT_SIZE = 222_752;
const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;

function address(seed: number): string {
  return getBase58Decoder().decode(new Uint8Array(32).fill(seed));
}
const OWNER = address(1);
const OTHER_WALLET = address(2);
const SESSION_SIGNER = address(3);
const MARKET = address(4);

function addressBytes(value: string): Uint8Array {
  return getBase58Encoder().encode(value) as Uint8Array;
}

function buildMarket(options: { initialized?: boolean; open?: boolean; oracleValid?: boolean; seatIndex?: number; seatOccupied?: boolean; seatTrader?: string } = {}): Uint8Array {
  const { initialized = true, open = true, oracleValid = true, seatIndex = 0, seatOccupied = true, seatTrader = OWNER } = options;
  const bytes = new Uint8Array(MARKET_ACCOUNT_SIZE);
  bytes[10] = initialized ? 1 : 0;
  bytes[11] = open ? 1 : 0;
  bytes[294] = oracleValid ? 1 : 0;
  const seatBase = TRADER_SEAT_OFFSET + seatIndex * TRADER_SEAT_SIZE;
  bytes[seatBase] = seatOccupied ? 1 : 0;
  bytes.set(addressBytes(seatTrader), seatBase + 1);
  return bytes;
}

function buildSession(options: {
  initialized?: boolean;
  revoked?: boolean;
  owner?: string;
  sessionSigner?: string;
  targetProgram?: string;
  market?: string;
  seatIndex?: number;
  expiresAt?: bigint;
  actions?: number;
  nextExpectedNonce?: bigint;
  maxOrderNotional?: bigint;
  maxCumulativeNotional?: bigint;
  consumedCumulativeNotional?: bigint;
  maxExposure?: bigint;
  maxOpenOrders?: number;
} = {}): Uint8Array {
  const {
    initialized = true, revoked = false, owner = OWNER, sessionSigner = SESSION_SIGNER,
    targetProgram = PROGRAM_ID, market = MARKET, seatIndex = 0,
    expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600), actions = SESSION_ACTION.place,
    nextExpectedNonce = 1n, maxOrderNotional = 1_000n, maxCumulativeNotional = 5_000n,
    consumedCumulativeNotional = 0n, maxExposure = 100n, maxOpenOrders = 4,
  } = options;
  const bytes = new Uint8Array(256);
  bytes.set(new TextEncoder().encode("STKSES02"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  bytes[10] = initialized ? 1 : 0;
  bytes[11] = revoked ? 1 : 0;
  bytes.set(addressBytes(owner), 12);
  bytes.set(addressBytes(sessionSigner), 44);
  bytes.set(addressBytes(targetProgram), 76);
  bytes.set(addressBytes(market), 108);
  view.setUint16(140, seatIndex, true);
  view.setBigUint64(150, expiresAt, true);
  bytes[158] = actions;
  view.setBigUint64(159, maxOrderNotional, true);
  view.setBigUint64(167, maxCumulativeNotional, true);
  view.setBigUint64(175, consumedCumulativeNotional, true);
  view.setBigUint64(183, maxExposure, true);
  view.setUint16(199, maxOpenOrders, true);
  view.setBigUint64(201, nextExpectedNonce, true);
  return bytes;
}

function baseInput(overrides: Partial<Parameters<typeof verifyTradingSession>[0]> = {}) {
  return {
    marketBytes: buildMarket(),
    sessionBytes: buildSession(),
    sessionAccountOwner: PROGRAM_ID,
    ownerWallet: OWNER,
    sessionSignerAddress: SESSION_SIGNER,
    seatIndex: 0,
    marketPda: MARKET,
    programId: PROGRAM_ID,
    actionNonce: 1n,
    opcode: 3,
    placeOrderFlags: 0,
    now: new Date(),
    ...overrides,
  };
}

describe("verifyPrivyToken", () => {
  const verifier = (solanaWallets: string[]): PrivyVerifier => ({
    verify: async () => ({ user_id: "user-1", app_id: APP_ID, solanaWallets }),
  });

  it("accepts a token whose user has the claimed wallet linked", async () => {
    const result = await verifyPrivyToken("token", APP_ID, OWNER, verifier([OWNER]));
    expect(result).toEqual({ userId: "user-1" });
  });

  it("rejects a claimed wallet the user never linked -- the core auth-bypass this fixes", async () => {
    const result = await verifyPrivyToken("token", APP_ID, OTHER_WALLET, verifier([OWNER]));
    expect(result).toEqual({ error: "privy_wallet_not_linked" });
  });

  it("rejects a token issued for a different Privy app", async () => {
    const result = await verifyPrivyToken("token", "some-other-app", OWNER, verifier([OWNER]));
    expect(result).toEqual({ error: "privy_wrong_audience" });
  });

  it("fails closed when the verifier throws", async () => {
    const result = await verifyPrivyToken("token", APP_ID, OWNER, { verify: async () => { throw new Error("network error"); } });
    expect(result).toEqual({ error: "privy_verification_failed" });
  });
});

describe("requiredSessionActions", () => {
  it("requires PLACE for an ordinary PlaceOrder", () => {
    expect(requiredSessionActions(3, 0)).toBe(SESSION_ACTION.place);
  });
  it("also accepts REDUCE_ONLY_CLOSE for a reduce-only PlaceOrder", () => {
    expect(requiredSessionActions(3, 4)).toBe(SESSION_ACTION.place | SESSION_ACTION.reduceOnlyClose);
  });
  it("requires CANCEL for CancelOrder", () => {
    expect(requiredSessionActions(4, 0)).toBe(SESSION_ACTION.cancel);
  });
  it("requires CANCEL_ALL for CancelAll", () => {
    expect(requiredSessionActions(5, 0)).toBe(SESSION_ACTION.cancelAll);
  });
  it("requires REPLACE for ReplaceOrder, never falling back to PLACE", () => {
    expect(requiredSessionActions(33, 0)).toBe(SESSION_ACTION.replace);
  });
  it("returns 0 for a non-session-relayable opcode", () => {
    expect(requiredSessionActions(10, 0)).toBe(0);
  });
});

describe("verifyTradingSession", () => {
  it("accepts V3 only with an explicit core and seat-shard projection", () => {
    const core = {
      kind: "v3" as const, instrument: MARKET, marketAuthority: OWNER, mode: 1,
      oracleValid: true, lastVerifiedOraclePrice: 100n, lastVerifiedOracleTimestamp: 1n,
      oracleFeedId: 922, oracleChannel: 0, oracleExponent: -2, delegationStatus: 0,
      expectedCommitSequence: 0n, lastCommittedSequence: 0n, validator: OWNER,
    };
    const seat = {
      shard: 0, slot: 0, trader: OWNER, availableCollateral: 1n, reservedMargin: 0n,
      basePosition: 0n, quoteEntryValue: 0n, realizedPnl: 0n, lastFundingAccumulator: 0n, openBidExposure: 0n,
      openAskExposure: 0n, openOrderCount: 0, liquidationState: 0, sequence: 1n,
    };
    expect(verifyTradingSession(baseInput({ marketBytes: new Uint8Array(4096), v3: { core, seat } }))).toEqual({ ok: true });
  });

  it("applies signed V3 order limits before sponsorship", () => {
    const core = {
      kind: "v3" as const, instrument: MARKET, marketAuthority: OWNER, mode: 1,
      oracleValid: true, lastVerifiedOraclePrice: 100n, lastVerifiedOracleTimestamp: 1n,
      oracleFeedId: 922, oracleChannel: 0, oracleExponent: -2, delegationStatus: 0,
      expectedCommitSequence: 0n, lastCommittedSequence: 0n, validator: OWNER,
    };
    const seat = {
      shard: 0, slot: 0, trader: OWNER, availableCollateral: 1_000n, reservedMargin: 0n,
      basePosition: 2n, quoteEntryValue: 0n, realizedPnl: 0n, lastFundingAccumulator: 0n, openBidExposure: 0n,
      openAskExposure: 0n, openOrderCount: 1, liquidationState: 0, sequence: 1n,
    };
    const v3 = { core, seat };
    const orderIntent = { quantity: 2n, priceOrOffset: 100n, side: 1 as const, tree: 0 as const, reduceOnly: true, replace: false };
    expect(verifyTradingSession(baseInput({ marketBytes: new Uint8Array(4096), v3, orderIntent }))).toEqual({ ok: true });
    expect(verifyTradingSession(baseInput({ marketBytes: new Uint8Array(4096), v3, orderIntent: { ...orderIntent, quantity: 20n, reduceOnly: false } }))).toEqual({ ok: false, reason: "session_notional_limit" });
    expect(verifyTradingSession(baseInput({ marketBytes: new Uint8Array(4096), v3, orderIntent: { ...orderIntent, side: 0, reduceOnly: false }, sessionBytes: buildSession({ maxExposure: 2n }) }))).toEqual({ ok: false, reason: "session_exposure_limit" });
    expect(verifyTradingSession(baseInput({ marketBytes: new Uint8Array(4096), v3, orderIntent: { ...orderIntent, quantity: 1n, side: 1, reduceOnly: false }, sessionBytes: buildSession({ maxOpenOrders: 1 }) }))).toEqual({ ok: false, reason: "session_open_order_limit" });
  });

  it("fails closed instead of applying V2 offsets to a V3 core", () => {
    expect(verifyTradingSession(baseInput({ marketBytes: new Uint8Array(4096) }))).toEqual({ ok: false, reason: "v3_context_required" });
  });

  it("accepts a fully valid chain", () => {
    expect(verifyTradingSession(baseInput())).toEqual({ ok: true });
  });

  it("rejects a market account of the wrong size", () => {
    const result = verifyTradingSession(baseInput({ marketBytes: new Uint8Array(10) }));
    expect(result).toEqual({ ok: false, reason: "market_wrong_size" });
  });

  it("rejects an uninitialized market", () => {
    const result = verifyTradingSession(baseInput({ marketBytes: buildMarket({ initialized: false }) }));
    expect(result).toEqual({ ok: false, reason: "market_not_initialized" });
  });

  it("rejects a market that isn't open", () => {
    const result = verifyTradingSession(baseInput({ marketBytes: buildMarket({ open: false }) }));
    expect(result).toEqual({ ok: false, reason: "market_not_open" });
  });

  it("rejects a market with no valid oracle price", () => {
    const result = verifyTradingSession(baseInput({ marketBytes: buildMarket({ oracleValid: false }) }));
    expect(result).toEqual({ ok: false, reason: "oracle_not_valid" });
  });

  it("rejects an unoccupied seat", () => {
    const result = verifyTradingSession(baseInput({ marketBytes: buildMarket({ seatOccupied: false }) }));
    expect(result).toEqual({ ok: false, reason: "seat_not_occupied" });
  });

  it("rejects when the seat's real on-chain trader is not the claimed owner wallet -- the seat/owner bypass this fixes", () => {
    const result = verifyTradingSession(baseInput({ marketBytes: buildMarket({ seatTrader: OTHER_WALLET }) }));
    expect(result).toEqual({ ok: false, reason: "seat_owner_mismatch" });
  });

  it("rejects when the derived TradingSession account does not exist", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: null, sessionAccountOwner: null }));
    expect(result).toEqual({ ok: false, reason: "session_not_found" });
  });

  it("rejects a session account not owned by the StockStream program -- nothing else could have written this layout honestly, but fail closed anyway", () => {
    const result = verifyTradingSession(baseInput({ sessionAccountOwner: "11111111111111111111111111111111111111111" }));
    expect(result).toEqual({ ok: false, reason: "session_not_found" });
  });

  it("rejects a revoked session", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ revoked: true }) }));
    expect(result).toEqual({ ok: false, reason: "session_revoked" });
  });

  it("rejects an expired session", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10) }) }));
    expect(result).toEqual({ ok: false, reason: "session_expired" });
  });

  it("rejects a session whose stored owner does not match the claimed wallet", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ owner: OTHER_WALLET }) }));
    expect(result).toEqual({ ok: false, reason: "session_owner_mismatch" });
  });

  it("rejects a session bound to a different session signer", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ sessionSigner: OTHER_WALLET }) }));
    expect(result).toEqual({ ok: false, reason: "session_signer_mismatch" });
  });

  it("rejects a session scoped to a different program deployment", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ targetProgram: OTHER_WALLET }) }));
    expect(result).toEqual({ ok: false, reason: "session_wrong_program" });
  });

  it("rejects a session scoped to a different market", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ market: OTHER_WALLET }) }));
    expect(result).toEqual({ ok: false, reason: "session_wrong_market" });
  });

  it("rejects a session scoped to a different seat index", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ seatIndex: 7 }) }));
    expect(result).toEqual({ ok: false, reason: "session_wrong_seat" });
  });

  it("rejects an opcode the session's action allowlist does not cover", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ actions: SESSION_ACTION.cancel }), opcode: 3, placeOrderFlags: 0 }));
    expect(result).toEqual({ ok: false, reason: "session_action_not_allowed" });
  });

  it("accepts a reduce-only PlaceOrder authorized only via REDUCE_ONLY_CLOSE", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ actions: SESSION_ACTION.reduceOnlyClose }), opcode: 3, placeOrderFlags: 4 }));
    expect(result).toEqual({ ok: true });
  });

  it("rejects a stale or replayed action nonce", () => {
    const result = verifyTradingSession(baseInput({ sessionBytes: buildSession({ nextExpectedNonce: 5n }), actionNonce: 1n }));
    expect(result).toEqual({ ok: false, reason: "session_nonce_mismatch" });
  });
});

describe("deriveTradingSessionAddress", () => {
  it("is deterministic for the same inputs", async () => {
    const a = await deriveTradingSessionAddress(OWNER, MARKET, 0, SESSION_SIGNER, PROGRAM_ID);
    const b = await deriveTradingSessionAddress(OWNER, MARKET, 0, SESSION_SIGNER, PROGRAM_ID);
    expect(a).toBe(b);
  });

  it("changes when any seed component changes", async () => {
    const a = await deriveTradingSessionAddress(OWNER, MARKET, 0, SESSION_SIGNER, PROGRAM_ID);
    const b = await deriveTradingSessionAddress(OWNER, MARKET, 1, SESSION_SIGNER, PROGRAM_ID);
    expect(a).not.toBe(b);
  });
});
