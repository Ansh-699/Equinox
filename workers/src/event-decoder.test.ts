import { describe, expect, it } from "vitest";
import { decodeCustodyEvents, type RawTransactionResult } from "./event-decoder";
import { eventLogLine as eventLogLineFor, seatAmountPayload } from "./test-event-fixtures";

const marketHex = "aa".repeat(32);
const eventLogLine = (discriminator: number, sequence: number, payload?: Uint8Array, timestamp?: number) =>
  eventLogLineFor(discriminator, sequence, marketHex, payload, timestamp);

function transaction(logMessages: string[], overrides: Partial<RawTransactionResult> = {}): RawTransactionResult {
  return {
    slot: 12345,
    meta: { logMessages, err: null },
    transaction: { signatures: ["sig1"] },
    ...overrides,
  };
}

describe("decodeCustodyEvents", () => {
  it("decodes a real binary event line into a sequenced MarketEvent", () => {
    const tx = transaction([
      "Program Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ invoke [1]",
      eventLogLine(401, 7, seatAmountPayload(4, 1000, 1000)), // 401 = CollateralDeposited
      "Program Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ success",
    ]);
    const events = decodeCustodyEvents(tx, "l1", 999);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("sig1:7");
    expect(events[0].symbol).toBe(marketHex);
    expect(events[0].kind).toBe("custody");
    expect(events[0].domain).toBe("l1");
    expect(events[0].sequence).toBe(7);
    expect(events[0].payload).toMatchObject({ kind: "CollateralDeposited", discriminator: 401, market: marketHex, signature: "sig1" });
  });

  it("buckets order/fill/oracle/session discriminators into their expected coarse kind", () => {
    const tx = transaction([
      eventLogLine(202, 1), // OrderPlaced -> book
      eventLogLine(204, 2), // OrderFilled -> fill
      eventLogLine(500, 3), // OracleUpdated -> oracle
      eventLogLine(302, 4), // FundingAccumulatorUpdated -> funding
      eventLogLine(700, 5), // TradingSessionAuthorized -> health
    ]);
    const events = decodeCustodyEvents(tx, "l1", 1);
    expect(events.map((e) => e.kind)).toEqual(["book", "fill", "oracle", "funding", "health"]);
  });

  it("preserves an unrecognized future discriminator instead of dropping it", () => {
    const tx = transaction([eventLogLine(9999, 1)]);
    const events = decodeCustodyEvents(tx, "l1", 1);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ kind: "Unknown(9999)", discriminator: 9999 });
  });

  it("decodes multiple events from the same transaction in log order", () => {
    const tx = transaction([eventLogLine(401, 3), eventLogLine(402, 4)]);
    const events = decodeCustodyEvents(tx, "l1", 1);
    expect(events.map((e) => e.sequence)).toEqual([3, 4]);
  });

  it("ignores unrelated program logs and malformed/truncated data lines without throwing", () => {
    const tx = transaction([
      "Program log: some other program's debug message",
      "Program data: " + btoa("too-short"),
      "Program data: not-valid-base64!!!",
    ]);
    expect(decodeCustodyEvents(tx, "l1", 1)).toEqual([]);
  });

  it("skips every log from a failed transaction (rolled-back state must never become an event)", () => {
    const tx = transaction([eventLogLine(401, 1)], {
      meta: { logMessages: [eventLogLine(401, 1)], err: { InstructionError: [0, "Custom"] } },
    });
    expect(decodeCustodyEvents(tx, "l1", 1)).toEqual([]);
  });

  it("falls back to a domain/market/sequence id when the transaction has no signature", () => {
    const tx = transaction([eventLogLine(400, 1)], { transaction: { signatures: [] } });
    expect(decodeCustodyEvents(tx, "er", 1)[0].id).toBe(`er:${marketHex}:1`);
  });
});
