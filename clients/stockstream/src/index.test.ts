import { PublicKey } from "@solana/web3.js";
import { expect, test } from "vitest";
import { STOCKSTREAM_PROGRAM_ID } from "./constants";
import { authorizeTradingSession, cancelOrder, commitMarket, createPerpMarket, decodeInstruction, delegateMarket, initializeExchange, initializeMarket, initializeVault, placeOrder, previewPlaceOrder, registerStockInstrument, undelegationCallback, updateStockInstrument } from "./index";

const market = PublicKey.unique();
const authority = PublicKey.unique();
const settlementScratch = PublicKey.unique();

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
  const ix = placeOrder({ market, authority, settlementScratch, seatIndex: 2, side: "bid", tree: "fixed", quantity: 12n, priceOrOffset: 123_450_000n, clientOrderId: 9n, reduceOnly: true });
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
  const preview = previewPlaceOrder({ market, authority, settlementScratch, seatIndex: 0, side: "ask", quantity: 2n, priceOrOffset: 100n, clientOrderId: 1n });
  expect(preview.programId).toBe(STOCKSTREAM_PROGRAM_ID);
  expect(preview.signers).toEqual([authority.toBase58()]);
  expect(preview.estimatedInternalMargin).toContain("verified oracle");
});

test("integration constructors preserve discriminators, account order and signer flags", () => {
  const mint = PublicKey.unique(); const tokenProgram = PublicKey.unique(); const vault = PublicKey.unique(); const vaultAuthority = PublicKey.unique();
  const vaultIx = initializeVault({ market, authority, mint, tokenProgram, vault, vaultAuthority });
  expect(vaultIx.data).toEqual(Buffer.from([9]));
  expect(vaultIx.keys.map((key) => [key.pubkey, key.isSigner, key.isWritable])).toEqual([[market, false, true], [authority, true, false], [mint, false, false], [tokenProgram, false, false], [vault, false, true], [vaultAuthority, false, false]]);
  expect(decodeInstruction(commitMarket({ market, authority }, 4n).data).name).toBe("CommitMarket");
  expect(decodeInstruction(delegateMarket({ market, authority, hotAccounts: [settlementScratch] }, 2n).data).name).toBe("DelegateMarket");
  expect(decodeInstruction(undelegationCallback({ market, authority }, 3n).data).name).toBe("UndelegationCallback");
  const session = authorizeTradingSession({ market, authority, session: PublicKey.unique(), sessionSigner: PublicKey.unique() }, 99n, 1n, { seatIndex: 0, actions: 3, maxOrderNotional: 10n, maxCumulativeNotional: 20n, maximumExposure: 30n, maximumOpenOrders: 2 });
  expect(decodeInstruction(session.data).name).toBe("AuthorizeTradingSession");
  expect(session.data).toHaveLength(54);
});

test("registry constructors preserve market-scoped account order", () => {
  const exchange = PublicKey.unique(); const instrument = PublicKey.unique(); const perpMarket = PublicKey.unique();
  const id = new Uint8Array(32); id.fill(7);
  expect(decodeInstruction(initializeExchange({ exchange, authority }).data).name).toBe("InitializeExchange");
  const register = registerStockInstrument({ exchange, instrument, authority }, id);
  expect(register.keys.map((key) => [key.pubkey, key.isSigner, key.isWritable])).toEqual([[exchange, false, true], [instrument, false, true], [authority, true, false]]);
  const create = createPerpMarket({ instrument, market: perpMarket, authority }, id);
  expect(decodeInstruction(create.data).name).toBe("CreatePerpMarket");
  expect(create.keys[0].pubkey).toBe(instrument);
  expect(create.keys[1].pubkey).toBe(perpMarket);
  const update = updateStockInstrument({ exchange, instrument, authority }, id, 77, 1, -6);
  expect(Array.from(update.data.slice(33))).toEqual([77, 0, 0, 0, 1, 250, 255, 255, 255]);
  expect(() => updateStockInstrument({ exchange, instrument, authority }, id, 0, 1, -6)).toThrow(/non-zero/);
});
