import { expect, test } from "vitest";
import {
  ER_WRITABLE_CLUSTERS,
  rejectMixedWritableDomains,
  validateTransactionAccountDomain,
  type WritableAccount,
} from "./magicblock";

const market = "Market11111111111111111111111111111111111";
const scratch = "Scratch11111111111111111111111111111111111";
const session = "Session11111111111111111111111111111111111";
const foreign = "Foreign11111111111111111111111111111111111";

function wa(address: string, domain: "l1" | "er" = "er", writable = true): WritableAccount {
  return { address, domain, writable };
}

test("correct cluster: every trading instruction's delegated writable set passes", () => {
  const cluster = {
    market: [market],
    settlementScratch: [scratch],
    tradingSession: [session],
  };
  expect(() =>
    validateTransactionAccountDomain("placeOrder", [wa(market), wa(scratch), wa(session)], cluster),
  ).not.toThrow();
  expect(() =>
    validateTransactionAccountDomain("cancelOrder", [wa(market), wa(session)], cluster),
  ).not.toThrow();
  expect(() => validateTransactionAccountDomain("funding", [wa(market)], cluster)).not.toThrow();
  expect(() => validateTransactionAccountDomain("liquidation", [wa(market)], cluster)).not.toThrow();
});

test("matrix: market delegated, scratch NOT delegated rejects PlaceOrder", () => {
  // The scratch exists on L1 only: an ER transaction writing it alongside the
  // delegated market is a mixed writable-domain transaction.
  expect(() =>
    validateTransactionAccountDomain(
      "placeOrder",
      [wa(market), wa(foreign)],
      { market: [market], settlementScratch: [scratch], tradingSession: [session] },
    ),
  ).toThrow(/outside the delegated ER domain/);
});

test("matrix: scratch delegated to a different validator is not in this ER domain", () => {
  // Modeling: only accounts of this market's single ER validator are in the
  // cluster; a second validator's copy is a foreign address here.
  expect(() =>
    validateTransactionAccountDomain(
      "placeOrder",
      [wa(market), wa("ScratchOther1111111111111111111111111111111")],
      { market: [market], settlementScratch: [scratch], tradingSession: [session] },
    ),
  ).toThrow(/outside the delegated ER domain/);
});

test("matrix: session-signed trade without a delegated session PDA rejects", () => {
  expect(() =>
    validateTransactionAccountDomain("cancelOrder", [wa(market), wa(session)], {
      market: [market],
      tradingSession: [],
    }),
  ).toThrow(/outside the delegated ER domain/);
});

test("matrix: oracle updates can never be an ER transaction", () => {
  expect(ER_WRITABLE_CLUSTERS.oracleUpdate).toEqual([]);
  // The consume_oracle_update instruction writes the Pyth program's own
  // storage/treasury accounts: even if someone marks them writable, they can
  // never be part of StockStream's delegated cluster.
  expect(() =>
    validateTransactionAccountDomain(
      "oracleUpdate",
      [wa(market, "er"), wa(foreign, "l1")],
      { market: [market] },
    ),
  ).toThrow(/outside the delegated ER domain/);
});

test("matrix: deposit/withdrawal vaults are L1-only", () => {
  expect(ER_WRITABLE_CLUSTERS.deposit).toEqual([]);
  expect(ER_WRITABLE_CLUSTERS.withdraw).toEqual([]);
  // Vaults (non-delegated) are legitimately writable in an L1-domain
  // transaction; the domain validator only governs ER submissions, so an
  // empty expected cluster with no writable delegated accounts passes when
  // the submission is L1 (domains all "l1").
  expect(() =>
    rejectMixedWritableDomains([wa(foreign, "l1"), wa(foreign, "l1")]),
  ).not.toThrow();
  // ...and mixing an ER-domain account into it is rejected.
  expect(() =>
    rejectMixedWritableDomains([wa(foreign, "l1"), wa(market, "er")]),
  ).toThrow(/mixed/);
});

test("duplicates in the transaction or the cluster reject", () => {
  expect(() =>
    validateTransactionAccountDomain("placeOrder", [wa(market), wa(market)], {
      market: [market],
      settlementScratch: [scratch],
      tradingSession: [session],
    }),
  ).toThrow(/duplicate writable/);
  expect(() =>
    validateTransactionAccountDomain("placeOrder", [wa(market)], {
      market: [market, market],
      settlementScratch: [scratch],
      tradingSession: [session],
    }),
  ).toThrow(/duplicate delegated/);
});

test("a delegated cluster member missing from the transaction rejects", () => {
  // A PlaceOrder transaction that forgets the scratch account it must write
  // would execute with a stale L1 scratch: rejected before submission.
  expect(() =>
    validateTransactionAccountDomain("placeOrder", [wa(market), wa(session)], {
      market: [market],
      settlementScratch: [scratch],
      tradingSession: [session],
    }),
  ).toThrow(/not writable in the/);
});

test("cancelAll and reduceOnlyClose have the expected shapes", () => {
  expect(ER_WRITABLE_CLUSTERS.cancelAll).toEqual(["market", "tradingSession"]);
  expect(ER_WRITABLE_CLUSTERS.reduceOnlyClose).toEqual([
    "market",
    "settlementScratch",
    "tradingSession",
  ]);
  expect(ER_WRITABLE_CLUSTERS.withdraw).toEqual([]);
});
