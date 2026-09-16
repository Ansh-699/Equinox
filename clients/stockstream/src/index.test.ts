import { PublicKey } from "@solana/web3.js";
import { expect, test } from "vitest";
import { STOCKSTREAM_PROGRAM_ID } from "./constants";
import { MAGICBLOCK_MAGIC_CONTEXT_ID, MAGICBLOCK_MAGIC_PROGRAM_ID } from "./index";
import { authorizeTradingSession, cancelOrder, commitMarket, createPerpMarket, decodeInstruction, decodeMarketState, decodeSeatAmountPayload, decodeStockStreamEvent, delegateMarket, deriveTradingSession, EVENT_SIZE, initializeExchange, initializeMarket, initializeVault, placeOrder, previewPlaceOrder, recordBadDebt, reconcileVault, registerStockInstrument, resolveBadDebt, transferToInsuranceFund, updateStockInstrument, withdrawInsuranceFunds, withdrawProtocolFees } from "./index";
import { STOCKSTREAM_ACCOUNT_SIZE } from "./constants";

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
  expect(ix.data.length).toBe(54);
  expect(Array.from(ix.data.slice(0, 4))).toEqual([3, 0, 0, 4]);
  expect(decodeInstruction(ix.data).name).toBe("PlaceOrder");
});

test("cancel order encodes a full 128-bit key", () => {
  const session = PublicKey.unique();
  const ix = cancelOrder({ market, authority, session }, 2, 2n ** 100n + 7n, 3n);
  expect(ix.data.length).toBe(27);
  expect(ix.keys[2]).toEqual({ pubkey: session, isSigner: false, isWritable: true });
  expect(decodeInstruction(ix.data).name).toBe("CancelOrder");
  expect(Array.from(ix.data.slice(19))).toEqual([3, 0, 0, 0, 0, 0, 0, 0]);
});

test("scoped action nonces are serialized while main wallet actions remain zero", () => {
  const session = PublicKey.unique();
  const scoped = placeOrder({ market, authority, settlementScratch, session, seatIndex: 2, side: "ask", quantity: 1n, priceOrOffset: 10n, clientOrderId: 10n, actionNonce: 9n });
  expect(Array.from(scoped.data.slice(46))).toEqual([9, 0, 0, 0, 0, 0, 0, 0]);
  expect(() => placeOrder({ market, authority, settlementScratch, seatIndex: 2, side: "ask", quantity: 1n, priceOrOffset: 10n, clientOrderId: 10n, actionNonce: 1n })).toThrow(/zero/);
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
  const payer = PublicKey.unique(); const instrument = PublicKey.unique(); const validator = PublicKey.unique();
  const commitIx = commitMarket({ market, authority, payer }, 4n);
  expect(decodeInstruction(commitIx.data).name).toBe("CommitMarket");
  expect(commitIx.keys.map((key) => key.pubkey.toBase58())).toEqual([market, authority, payer, MAGICBLOCK_MAGIC_CONTEXT_ID, MAGICBLOCK_MAGIC_PROGRAM_ID].map((k) => k.toBase58()));
  const delegateIx = delegateMarket({ market, authority, instrument, payer, scratchAccounts: [settlementScratch] }, validator);
  expect(decodeInstruction(delegateIx.data).name).toBe("DelegateMarket");
  expect(Array.from(delegateIx.data.slice(1))).toEqual(Array.from(validator.toBytes()));
  expect(delegateIx.keys).toHaveLength(11);
  expect(delegateIx.keys[10]).toEqual({ pubkey: settlementScratch, isSigner: false, isWritable: true });
  const session = authorizeTradingSession({ market, authority, payer: authority, sessionSigner: PublicKey.unique() }, 99n, { seatIndex: 0, actions: 3, maxOrderNotional: 10n, maxCumulativeNotional: 20n, maximumExposure: 30n, maximumOpenOrders: 2 });
  expect(decodeInstruction(session.data).name).toBe("AuthorizeTradingSession");
  expect(session.data).toHaveLength(46);
  expect(session.keys).toHaveLength(5);
  const derivedPda = deriveTradingSession(authority, market, 0, session.keys[3].pubkey);
  expect(session.keys[2].pubkey.toBase58()).toBe(derivedPda.toBase58());
});

test("trading session PDA derivation matches the Rust program byte-for-byte", () => {
  // Golden vector cross-checked against `derive_trading_session` in
  // programs/stockstream/tests/trading_session.rs
  // (`derive_trading_session_golden_vector_for_cross_language_parity`) --
  // same owner/market/seat/signer inputs, same resulting PDA bytes.
  const owner = new PublicKey(new Uint8Array(32).fill(1));
  const market = new PublicKey(new Uint8Array(32).fill(2));
  const signer = new PublicKey(new Uint8Array(32).fill(3));
  const pda = deriveTradingSession(owner, market, 7, signer);
  expect(Array.from(pda.toBytes())).toEqual([
    15, 27, 164, 236, 73, 126, 218, 96, 7, 34, 216, 162, 61, 204, 142, 55, 237, 185, 14, 91, 242,
    94, 221, 124, 205, 156, 101, 221, 191, 43, 230, 214,
  ]);
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

test("custody fee/insurance/reconciliation constructors use canonical discriminators and account order", () => {
  const vault = PublicKey.unique(); const vaultAuthority = PublicKey.unique();
  const destination = PublicKey.unique(); const mint = PublicKey.unique(); const tokenProgram = PublicKey.unique();

  const transfer = transferToInsuranceFund({ market, authority }, 500n);
  expect(decodeInstruction(transfer.data).name).toBe("TransferToInsuranceFund");
  expect(Array.from(transfer.data)).toEqual([34, 244, 1, 0, 0, 0, 0, 0, 0]);
  expect(transfer.keys).toEqual([
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ]);

  const ledgerAccounts = { market, authority, vault, vaultAuthority, destination, mint, tokenProgram };
  const fees = withdrawProtocolFees(ledgerAccounts, 10n);
  expect(decodeInstruction(fees.data).name).toBe("WithdrawProtocolFees");
  expect(fees.keys.map((key) => [key.pubkey, key.isSigner, key.isWritable])).toEqual([
    [market, false, true], [authority, true, false], [vault, false, true], [vaultAuthority, false, false],
    [destination, false, true], [mint, false, false], [tokenProgram, false, false],
  ]);
  const insurance = withdrawInsuranceFunds(ledgerAccounts, 10n);
  expect(decodeInstruction(insurance.data).name).toBe("WithdrawInsuranceFunds");
  expect(insurance.data[0]).toBe(36);

  const record = recordBadDebt({ market, authority }, 3, 42n);
  expect(decodeInstruction(record.data).name).toBe("RecordBadDebt");
  expect(record.data.length).toBe(11);
  expect(Array.from(record.data.slice(1, 3))).toEqual([3, 0]);
  const resolve = resolveBadDebt({ market, authority }, 42n);
  expect(decodeInstruction(resolve.data).name).toBe("ResolveBadDebt");

  const reconcile = reconcileVault({ market, vault, mint, tokenProgram });
  expect(decodeInstruction(reconcile.data).name).toBe("ReconcileVault");
  expect(reconcile.data).toEqual(Buffer.from([39]));
  expect(reconcile.keys).toEqual([
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ]);
});

function marketHeaderFixture(version: number): Uint8Array {
  const data = new Uint8Array(STOCKSTREAM_ACCOUNT_SIZE);
  const view = new DataView(data.buffer);
  data.set(new TextEncoder().encode("STKMRK01"), 0);
  view.setUint16(8, version, true);
  view.setUint32(311, 512, true);
  view.setUint32(315, 91152, true);
  view.setUint32(319, 181792, true);
  view.setUint32(323, 214560, true);
  view.setBigUint64(449, 111n, true);
  view.setBigUint64(457, 222n, true);
  view.setBigUint64(465, 333n, true);
  view.setUint8(473, 2);
  view.setBigUint64(474, 444n, true);
  return data;
}

test("decodeMarketState golden vector: custody-ledger byte offsets match the Rust layout and version 1 is rejected", () => {
  // Golden vector cross-checked against
  // `programs/stockstream/tests/account_settlement.rs::custody_ledger_field_offsets_match_the_typescript_decoder`
  // -- same absolute byte offsets (449, 457, 465, 473, 474) for the
  // Priority-4 custody ledger fields added at MARKET_VERSION 2.
  const state = decodeMarketState(marketHeaderFixture(2));
  expect(state.version).toBe(2);
  expect(state.protocolFeeBalance).toBe(111n);
  expect(state.insuranceFundBalance).toBe(222n);
  expect(state.recognizedBadDebt).toBe(333n);
  expect(state.reconciliationStatus).toBe(2);
  expect(state.vaultSurplus).toBe(444n);
  expect(() => decodeMarketState(marketHeaderFixture(1))).toThrow(/Invalid StockStream market header/);
});

function encodeEventFixture(discriminator: number, sequence: bigint, market: Buffer, timestamp: bigint, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(EVENT_SIZE);
  bytes.writeUInt16LE(discriminator, 0);
  bytes.writeUInt8(1, 2); // abi_version
  bytes.writeBigUInt64LE(sequence, 4);
  market.copy(bytes, 12);
  bytes.writeBigUInt64LE(timestamp, 44);
  payload.copy(bytes, 52);
  return bytes;
}

test("decodeStockStreamEvent parses a Program data line using the binary event ABI", () => {
  const market = Buffer.alloc(32, 0xaa);
  const payload = Buffer.alloc(48);
  payload.writeUInt16LE(4, 0); // seatIndex
  payload.writeBigUInt64LE(1000n, 2); // amount
  payload.writeBigUInt64LE(1000n, 10); // balance
  const bytes = encodeEventFixture(401, 7n, market, 1_700_000_000n, payload); // 401 = CollateralDeposited
  const line = `Program data: ${bytes.toString("base64")}`;

  const event = decodeStockStreamEvent(line);
  expect(event).not.toBeNull();
  expect(event?.kind).toBe("CollateralDeposited");
  expect(event?.discriminator).toBe(401);
  expect(event?.abiVersion).toBe(1);
  expect(event?.sequence).toBe(7n);
  expect(event?.market).toBe(market.toString("hex"));
  expect(event?.timestamp).toBe(1_700_000_000n);
  expect(decodeSeatAmountPayload(event!.payload)).toEqual({ seatIndex: 4, amount: 1000n, balance: 1000n });

  expect(decodeStockStreamEvent("Program log: not an event")).toBeNull();
  expect(decodeStockStreamEvent(`Program data: ${Buffer.alloc(10).toString("base64")}`)).toBeNull();
});

test("decodeStockStreamEvent preserves an unrecognized future discriminator instead of dropping it", () => {
  const market = Buffer.alloc(32, 0x01);
  const bytes = encodeEventFixture(9999, 1n, market, 0n, Buffer.alloc(48));
  const event = decodeStockStreamEvent(`Program data: ${bytes.toString("base64")}`);
  expect(event?.kind).toBe("Unknown(9999)");
  expect(event?.discriminator).toBe(9999);
});
