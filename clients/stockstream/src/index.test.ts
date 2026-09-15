import { PublicKey } from "@solana/web3.js";
import { expect, test } from "vitest";
import { STOCKSTREAM_PROGRAM_ID } from "./constants";
import { cancelOrder, decodeInstruction, initializeMarket, placeOrder, previewPlaceOrder } from "./index";

const market = PublicKey.unique();
const authority = PublicKey.unique();

test("instruction constructors use canonical program id and exact account flags", () => {
  const ix = initializeMarket({ market, authority });
  expect(ix.programId.toBase58()).toBe(STOCKSTREAM_PROGRAM_ID);
  expect(ix.data).toEqual(Buffer.from([0]));
  expect(ix.keys).toEqual([
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ]);
});

test("place order serializes little-endian fields and decodes", () => {
  const ix = placeOrder({ market, authority, seatIndex: 2, side: "bid", tree: "fixed", quantity: 12n, priceOrOffset: 123_450_000n, clientOrderId: 9n, reduceOnly: true });
  expect(ix.data.length).toBe(46);
  expect(Array.from(ix.data.slice(0, 4))).toEqual([3, 0, 0, 4]);
  expect(decodeInstruction(ix.data).name).toBe("PlaceOrder");
});

test("cancel order encodes a full 128-bit key", () => {
  const ix = cancelOrder({ market, authority }, 2, 2n ** 100n + 7n);
  expect(ix.data.length).toBe(19);
  expect(decodeInstruction(ix.data).name).toBe("CancelOrder");
});

test("transaction preview is unsigned and explicit about unavailable margin", () => {
  const preview = previewPlaceOrder({ market, authority, seatIndex: 0, side: "ask", quantity: 2n, priceOrOffset: 100n, clientOrderId: 1n });
  expect(preview.programId).toBe(STOCKSTREAM_PROGRAM_ID);
  expect(preview.signers).toEqual([authority.toBase58()]);
  expect(preview.estimatedInternalMargin).toContain("verified oracle");
});
