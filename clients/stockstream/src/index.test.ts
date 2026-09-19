import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect, test } from "vitest";
import { STOCKSTREAM_PROGRAM_ID } from "./constants";
import { MAGICBLOCK_DELEGATION_PROGRAM_ID, MAGICBLOCK_MAGIC_CONTEXT_ID, MAGICBLOCK_MAGIC_PROGRAM_ID, STOCKSTREAM_PROGRAM_KEY } from "./index";
import { authorizeTradingSession, cancelOrder, closeV3TraderSeat, commitMarket, delegateClusterMember, delegateV3Account, deriveClusterMemberPdas, createPerpMarket, createV3Account, createV3TraderSeat, decodeFillPayload, decodeInstruction, decodeMarketState, decodeSeatAmountPayload, decodeStockStreamEvent, delegateMarket, deriveTradingSession, depositCollateral, EVENT_SIZE, initializeExchange, initializeMarket, initializeV3Market, initializeVault, placeOrder, previewPlaceOrder, recordBadDebt, reconcileVault, registerStockInstrument, resolveBadDebt, transferToInsuranceFund, updateExchangeConfig, updateStockInstrument, withdrawCollateral, withdrawInsuranceFunds, withdrawProtocolFees, EXCHANGE_CONFIG_FIELD } from "./index";
import { STOCKSTREAM_ACCOUNT_SIZE } from "./constants";
import { deriveBookPageV3, deriveEventShardV3, deriveMarketCoreV3, deriveSeatShardV3 } from "./abi/v3";

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

test("createV3Account validates the isolated PDA and preserves the program account ABI", () => {
  const instrument = PublicKey.unique();
  const payer = PublicKey.unique();
  const core = deriveMarketCoreV3(instrument);
  const coreIx = createV3Account({ parent: instrument, target: core, payer }, "core");
  expect(Array.from(coreIx.data)).toEqual([46, 0, 0]);
  expect(coreIx.keys).toEqual([
    { pubkey: instrument, isSigner: false, isWritable: false },
    { pubkey: core, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]);
  const page = deriveBookPageV3(core, 1, 3);
  expect(Array.from(createV3Account({ parent: core, target: page, payer }, "book-page", 7).data)).toEqual([46, 1, 7]);
  expect(() => createV3Account({ parent: core, target: market, payer }, "book-page", 0)).toThrow(/derived/);
  expect(() => createV3Account({ parent: core, target: page, payer }, "book-page", 8)).toThrow(/index/);
  const activation = initializeV3Market({ exchange: PublicKey.unique(), instrument, core, authority });
  expect(Array.from(activation.data)).toEqual([47]);
  expect(activation.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable])).toEqual([[false, false], [false, false], [false, true], [true, false]]);
  expect(() => initializeV3Market({ exchange: PublicKey.unique(), instrument, core: market, authority })).toThrow(/derived/);
  const validator = PublicKey.unique();
  const delegation = delegateV3Account({ parent: core, target: page, authority, payer }, "book-page", validator, 7);
  expect(Array.from(delegation.data)).toEqual([48, 1, 7, ...validator.toBytes()]);
  expect(delegation.keys).toHaveLength(10);
  expect(delegation.keys.slice(0, 4).map(({ isSigner, isWritable }) => [isSigner, isWritable])).toEqual([[false, false], [false, true], [true, false], [true, true]]);
  const seatShards = Array.from({ length: 4 }, (_, index) => deriveSeatShardV3(core, index));
  const eventShards = Array.from({ length: 4 }, (_, index) => deriveEventShardV3(core, index));
  const seat = createV3TraderSeat({ core, seatShards, eventShards, trader: authority }, 32);
  expect(Array.from(seat.data)).toEqual([49, 32, 0]);
  expect(seat.keys).toHaveLength(10);
  expect(Array.from(closeV3TraderSeat({ core, seatShards, eventShards, trader: authority }, 32).data)).toEqual([50, 32, 0]);
  expect(() => createV3TraderSeat({ core, seatShards: seatShards.slice(0, 3), eventShards, trader: authority }, 0)).toThrow(/four/);
});

test("depositCollateral encodes exactly 6 accounts -- no separate seat-slot account", () => {
  const vault = PublicKey.unique();
  const vaultAuthority = PublicKey.unique();
  const mint = PublicKey.unique();
  const tokenProgram = PublicKey.unique();
  const sourceOrDestination = PublicKey.unique();
  const ix = depositCollateral({ market, authority, mint, tokenProgram, vault, vaultAuthority, seatIndex: 0, sourceOrDestination }, 400n);
  expect(ix.data.length).toBe(11);
  expect(ix.keys).toEqual([
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: sourceOrDestination, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ]);
});

test("withdrawCollateral encodes 7 accounts including the derived vault authority", () => {
  const vault = PublicKey.unique();
  const mint = PublicKey.unique();
  const tokenProgram = PublicKey.unique();
  const sourceOrDestination = PublicKey.unique();
  const ix = withdrawCollateral({ market, authority, mint, tokenProgram, vault, vaultAuthority: PublicKey.unique(), seatIndex: 0, sourceOrDestination }, 400n);
  expect(ix.keys).toHaveLength(7);
  expect(ix.keys[0]).toEqual({ pubkey: market, isSigner: false, isWritable: true });
  expect(ix.keys[1]).toEqual({ pubkey: authority, isSigner: true, isWritable: false });
  expect(ix.keys[2]).toEqual({ pubkey: sourceOrDestination, isSigner: false, isWritable: true });
  expect(ix.keys[3]).toEqual({ pubkey: mint, isSigner: false, isWritable: false });
  expect(ix.keys[4]).toEqual({ pubkey: vault, isSigner: false, isWritable: true });
  expect(ix.keys[6]).toEqual({ pubkey: tokenProgram, isSigner: false, isWritable: false });
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
  const delegateIx = delegateMarket({ market, authority, instrument, payer, clusterAccounts: [settlementScratch] }, validator);
  expect(decodeInstruction(delegateIx.data).name).toBe("DelegateMarket");
  expect(Array.from(delegateIx.data.slice(1))).toEqual(Array.from(validator.toBytes()));
  expect(delegateIx.keys).toHaveLength(11);
  expect(delegateIx.keys[10]).toEqual({ pubkey: settlementScratch, isSigner: false, isWritable: true });
  const memberIx = delegateClusterMember({ market, authority, member: settlementScratch, payer }, validator);
  expect(decodeInstruction(memberIx.data).name).toBe("DelegateClusterMember");
  expect(Array.from(memberIx.data.slice(1))).toEqual(Array.from(validator.toBytes()));
  expect(memberIx.keys).toHaveLength(10);
  expect(memberIx.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable])).toEqual([
    [market.toBase58(), false, false],
    [authority.toBase58(), true, false],
    [settlementScratch.toBase58(), false, true],
    [deriveClusterMemberPdas(settlementScratch).buffer.toBase58(), false, true],
    [deriveClusterMemberPdas(settlementScratch).delegationRecord.toBase58(), false, true],
    [deriveClusterMemberPdas(settlementScratch).delegationMetadata.toBase58(), false, true],
    [payer.toBase58(), true, true],
    [MAGICBLOCK_DELEGATION_PROGRAM_ID.toBase58(), false, false],
    [SystemProgram.programId.toBase58(), false, false],
    [STOCKSTREAM_PROGRAM_KEY.toBase58(), false, false],
  ]);
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
    125, 162, 29, 118, 27, 45, 12, 7, 145, 26, 112, 167, 48, 66, 157, 222, 25, 50, 106, 253, 233,
    65, 64, 174, 157, 225, 189, 138, 50, 249, 131, 131,
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

test("updateExchangeConfig derives the field mask from provided keys and writes every field at its exact offset", () => {
  const exchange = PublicKey.unique();
  const keeperAuthority = PublicKey.unique();
  const ix = updateExchangeConfig(
    { exchange, authority },
    { makerFeeBps: 10, takerFeeBps: 20, keeperAuthority },
    5n,
  );
  expect(decodeInstruction(ix.data).name).toBe("UpdateExchangeConfig");
  expect(ix.data.length).toBe(196);
  expect(ix.keys).toEqual([
    { pubkey: exchange, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ]);
  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  const fieldMask = view.getUint32(1, true);
  expect(fieldMask).toBe(EXCHANGE_CONFIG_FIELD.makerFeeBps | EXCHANGE_CONFIG_FIELD.takerFeeBps | EXCHANGE_CONFIG_FIELD.keeperAuthority);
  expect(view.getUint16(101, true)).toBe(10); // makerFeeBps
  expect(view.getUint16(103, true)).toBe(20); // takerFeeBps
  expect(Array.from(ix.data.slice(69, 101))).toEqual(Array.from(keeperAuthority.toBytes())); // keeperAuthority
  expect(view.getBigUint64(188, true)).toBe(5n); // expectedConfigSequence
  // Every field not in the mask must be present but zeroed.
  expect(Array.from(ix.data.slice(5, 37))).toEqual(new Array(32).fill(0)); // pauseAuthority
  expect(view.getUint8(187)).toBe(0); // protocolStatus
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
  view.setUint8(11, 1); // mode
  data.fill(0x07, 76, 108); // emergency_authority
  view.setUint16(194, 750, true); // maintenance_margin_bps
  view.setUint16(198, 5, true); // maker_fee_bps
  view.setUint16(200, 15, true); // taker_fee_bps
  view.setBigInt64(238, 12n, true); // current_open_interest (positive fits in the low 8 bytes with correct zero sign-extension)
  view.setBigUint64(262, 99n, true); // global_event_sequence
  view.setBigInt64(270, 5_000n, true); // funding_accumulator low bytes
  view.setBigUint64(286, 1_700_000_100n, true); // last_funding_timestamp
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
  expect(state.mode).toBe(1);
  expect(state.emergencyAuthority.toBytes()).toEqual(new Uint8Array(32).fill(0x07));
  expect(state.maintenanceMarginBps).toBe(750);
  expect(state.makerFeeBps).toBe(5);
  expect(state.takerFeeBps).toBe(15);
  expect(state.currentOpenInterest).toBe(12n);
  expect(state.globalEventSequence).toBe(99n);
  expect(state.fundingAccumulator).toBe(5_000n);
  expect(state.lastFundingTimestamp).toBe(1_700_000_100n);
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

// Golden vectors for the discriminators newly wired into production Rust
// handlers this session (`handlers.rs`/`magicblock.rs`): OrderFilled and
// OrderPartiallyFilled share `payload_fill`'s byte shape but a distinct
// discriminator (204 vs 203); the rest exercise the session/liquidation/
// MagicBlock payload shapes now emitted by real handlers.
test("decodeStockStreamEvent distinguishes OrderFilled from OrderPartiallyFilled sharing the fill payload shape", () => {
  const market = Buffer.alloc(32, 0xbb);
  const fillPayload = Buffer.alloc(48);
  fillPayload.writeUInt32LE(1, 0); // makerSeat
  fillPayload.writeUInt32LE(2, 4); // takerSeat
  fillPayload.writeBigInt64LE(100n, 8); // price
  fillPayload.writeBigUInt64LE(5n, 16); // quantity
  fillPayload.writeBigUInt64LE(10n, 24); // fillSequence

  const full = decodeStockStreamEvent(`Program data: ${encodeEventFixture(204, 10n, market, 0n, fillPayload).toString("base64")}`);
  expect(full?.kind).toBe("OrderFilled");
  expect(decodeFillPayload(full!.payload)).toEqual({ makerSeat: 1, takerSeat: 2, price: 100n, quantity: 5n, fillSequence: 10n });

  const partial = decodeStockStreamEvent(`Program data: ${encodeEventFixture(203, 11n, market, 0n, fillPayload).toString("base64")}`);
  expect(partial?.kind).toBe("OrderPartiallyFilled");
  expect(partial?.discriminator).not.toBe(full?.discriminator);
});

test("decodeStockStreamEvent decodes the newly-wired session, liquidation, and MagicBlock event kinds", () => {
  const market = Buffer.alloc(32, 0xcc);
  const cases: Array<[number, string]> = [
    [206, "CancelAllProgress"],
    [207, "OrderReplaced"],
    [702, "TradingSessionActionConsumed"],
    [304, "LiquidationStarted"],
    [300, "PositionChanged"],
    [301, "MarginChanged"],
    [303, "FundingSettled"],
    [209, "InvalidOrderRemoved"],
    [208, "OrderExpired"],
    [600, "DelegationRequested"],
    [603, "CommitSequenceChanged"],
    [605, "RestorationPending"],
  ];
  for (const [discriminator, name] of cases) {
    const bytes = encodeEventFixture(discriminator, 1n, market, 0n, Buffer.alloc(48));
    const event = decodeStockStreamEvent(`Program data: ${bytes.toString("base64")}`);
    expect(event?.kind).toBe(name);
    expect(event?.discriminator).toBe(discriminator);
  }
});
