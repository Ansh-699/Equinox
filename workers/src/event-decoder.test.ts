import { describe, expect, it } from "vitest";
import { decodeCustodyEvents, type RawTransactionResult } from "./event-decoder";

const market = "aa".repeat(32);
const mint = "bb".repeat(32);

function transaction(logMessages: string[], overrides: Partial<RawTransactionResult> = {}): RawTransactionResult {
  return {
    slot: 12345,
    meta: { logMessages, err: null },
    transaction: { signatures: ["sig1"] },
    ...overrides,
  };
}

describe("decodeCustodyEvents", () => {
  it("decodes a real custody log line into a sequenced MarketEvent", () => {
    const tx = transaction([
      "Program 6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU invoke [1]",
      `Program log: SS:CollateralDeposited market=${market} seat=4 amount=1000 seq=7 balance=1000 mint=${mint}`,
      "Program 6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU success",
    ]);
    const events = decodeCustodyEvents(tx, "l1", 999);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: "sig1:7",
      symbol: market,
      kind: "custody",
      slot: 12345,
      domain: "l1",
      sequence: 7,
      payload: { kind: "CollateralDeposited", market, seat: 4, amount: "1000", balance: "1000", mint, signature: "sig1" },
      observedAt: 999,
    });
  });

  it("decodes an event with no seat field (market-level events)", () => {
    const tx = transaction([`Program log: SS:VaultInitialized market=${market} amount=0 seq=1 balance=0 mint=${mint}`]);
    const events = decodeCustodyEvents(tx, "er", 1);
    expect(events[0].payload.seat).toBeUndefined();
  });

  it("decodes multiple custody events from the same transaction in log order", () => {
    const tx = transaction([
      `Program log: SS:CollateralDeposited market=${market} seat=1 amount=100 seq=3 balance=100 mint=${mint}`,
      `Program log: SS:ProtocolFeeCollected market=${market} amount=5 seq=4 balance=5 mint=${mint}`,
    ]);
    const events = decodeCustodyEvents(tx, "l1", 1);
    expect(events.map((e) => e.sequence)).toEqual([3, 4]);
  });

  it("ignores unrelated program logs and malformed custody-shaped lines without throwing", () => {
    const tx = transaction([
      "Program log: some other program's debug message",
      "Program log: SS:CollateralDeposited market=not-hex seat=1 amount=1 seq=1 balance=1 mint=" + mint,
      `Program log: SS:CollateralDeposited market=${market} amount=oops seq=1 balance=1 mint=${mint}`,
    ]);
    expect(decodeCustodyEvents(tx, "l1", 1)).toEqual([]);
  });

  it("skips every log from a failed transaction (rolled-back state must never become an event)", () => {
    const tx = transaction([`Program log: SS:CollateralDeposited market=${market} amount=1 seq=1 balance=1 mint=${mint}`], {
      meta: { logMessages: [`Program log: SS:CollateralDeposited market=${market} amount=1 seq=1 balance=1 mint=${mint}`], err: { InstructionError: [0, "Custom"] } },
    });
    expect(decodeCustodyEvents(tx, "l1", 1)).toEqual([]);
  });

  it("falls back to a domain/market/sequence id when the transaction has no signature", () => {
    const tx = transaction([`Program log: SS:VaultInitialized market=${market} amount=0 seq=1 balance=0 mint=${mint}`], {
      transaction: { signatures: [] },
    });
    expect(decodeCustodyEvents(tx, "er", 1)[0].id).toBe(`er:${market}:1`);
  });

  it("rejects a zero or non-numeric sequence", () => {
    const tx = transaction([`Program log: SS:VaultInitialized market=${market} amount=0 seq=0 balance=0 mint=${mint}`]);
    expect(decodeCustodyEvents(tx, "l1", 1)).toEqual([]);
  });
});
