import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  V3_BOOK_PAGE_SIZE, V3_BOOK_SLOTS_PER_SIDE, V3_COMMIT_ACCOUNT_HARD_MAX,
  V3_COMMIT_ACCOUNT_SAFE_MAX, V3_EVENT_SHARD_SIZE, V3_MARKET_CORE_SIZE,
  V3_SEAT_SHARD_SIZE, V3_EXECUTION_BUNDLE_LEN, ORACLE_SNAPSHOT_SIZE, deriveBookPageV3, deriveEventShardV3,
  deriveMarketCoreV3, deriveSeatShardV3, deriveOracleSnapshotV3, v3AccountIsCommittable,
  decodeV3BookPage, decodeV3MarketCore,
  decodeV3EventShard, decodeV3SeatShard, decodeOracleSnapshotV3,
} from "./v3";
import { authorizeTradingSessionV3, closeTradingSessionV3, commitMarketV3, commitV3Shard, createOracleSnapshotV3, deriveV3ExecutionAccounts, placeOrderV3, reconcileVaultV3, revokeTradingSessionV3, updateFundingV3, updateTradingSessionV3 } from "./v3-instructions";

import { createV3TradingSession } from "./v3-instructions";

function key(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff));
}

describe("V3 sharded ABI", () => {
  const instrument = new PublicKey("11111111111111111111111111111111");

  it("keeps the required 1,024 slots per side below MagicBlock commit limits", () => {
    expect(V3_BOOK_SLOTS_PER_SIDE).toBe(1_024);
    expect(V3_EXECUTION_BUNDLE_LEN).toBe(27);
    for (const size of [V3_MARKET_CORE_SIZE, V3_BOOK_PAGE_SIZE, V3_SEAT_SHARD_SIZE, V3_EVENT_SHARD_SIZE]) {
      expect(v3AccountIsCommittable(size)).toBe(true);
      expect(size).toBeLessThan(V3_COMMIT_ACCOUNT_SAFE_MAX);
      expect(size).toBeLessThan(V3_COMMIT_ACCOUNT_HARD_MAX);
    }
    expect(v3AccountIsCommittable(V3_COMMIT_ACCOUNT_SAFE_MAX)).toBe(true);
    expect(v3AccountIsCommittable(222_752)).toBe(false);
    expect(v3AccountIsCommittable(10_241)).toBe(false);
    expect(v3AccountIsCommittable(-1)).toBe(false);
    expect(v3AccountIsCommittable(10_240.5)).toBe(false);
  });

  it("pins the V3 full-commit account order and signer/writable flags", () => {
    const accounts = {
      core: key(1),
      bookPages: Array.from({ length: 18 }, (_, index) => key(10 + index)),
      seatShards: Array.from({ length: 4 }, (_, index) => key(40 + index)),
      eventShards: Array.from({ length: 4 }, (_, index) => key(50 + index)),
      authority: key(60), payer: key(61), magicContext: key(62), magicProgram: key(63),
    };
    const ix = commitMarketV3(accounts, 0x0102030405060708n);
    expect([...ix.data]).toEqual([14, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(ix.keys.map(({ pubkey, isSigner, isWritable }) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable }))).toEqual([
      { pubkey: accounts.core.toBase58(), isSigner: false, isWritable: true },
      { pubkey: accounts.authority.toBase58(), isSigner: true, isWritable: false },
      { pubkey: accounts.payer.toBase58(), isSigner: true, isWritable: true },
      { pubkey: accounts.magicContext.toBase58(), isSigner: false, isWritable: true },
      { pubkey: accounts.magicProgram.toBase58(), isSigner: false, isWritable: false },
      ...[...accounts.bookPages, ...accounts.seatShards, ...accounts.eventShards]
        .map((pubkey) => ({ pubkey: pubkey.toBase58(), isSigner: false, isWritable: true })),
    ]);
  });

  it("pins the bounded shard commit context and flags", () => {
    const accounts = { shard: key(70), core: key(71), authority: key(72), payer: key(73), magicContext: key(74), magicProgram: key(75) };
    const ix = commitV3Shard(accounts, 9n, true);
    expect([...ix.data]).toEqual([15, 9, 0, 0, 0, 0, 0, 0, 0]);
    expect(ix.keys.map(({ pubkey, isSigner, isWritable }) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable }))).toEqual([
      { pubkey: accounts.shard.toBase58(), isSigner: false, isWritable: true },
      { pubkey: accounts.authority.toBase58(), isSigner: true, isWritable: false },
      { pubkey: accounts.payer.toBase58(), isSigner: true, isWritable: true },
      { pubkey: accounts.magicContext.toBase58(), isSigner: false, isWritable: true },
      { pubkey: accounts.magicProgram.toBase58(), isSigner: false, isWritable: false },
      { pubkey: accounts.core.toBase58(), isSigner: false, isWritable: true },
    ]);
  });

  it("derives distinct page and shard PDAs from the V3 core", () => {
    const market = deriveMarketCoreV3(instrument);
    expect(deriveBookPageV3(market, 0, 0)).not.toEqual(deriveBookPageV3(market, 0, 1));
    expect(deriveBookPageV3(market, 0, 0)).not.toEqual(deriveBookPageV3(market, 1, 0));
    expect(deriveSeatShardV3(market, 0)).not.toEqual(deriveSeatShardV3(market, 1));
    expect(deriveEventShardV3(market, 0)).not.toEqual(deriveEventShardV3(market, 1));
    expect(() => deriveBookPageV3(market, 2, 0)).toThrow(RangeError);
    expect(() => deriveSeatShardV3(market, 4)).toThrow(RangeError);
  });

  it("derives the complete canonical execution bundle for V3 writes", () => {
    const market = deriveMarketCoreV3(instrument);
    const accounts = deriveV3ExecutionAccounts(market, key(80), key(81));
    expect(accounts.bookPages).toHaveLength(18);
    expect(accounts.seatShards).toHaveLength(4);
    expect(accounts.eventShards).toHaveLength(4);
    const ix = placeOrderV3({ ...accounts, seatIndex: 0, side: "bid", quantity: 1, priceOrOffset: 10, expiresAt: 100, clientOrderId: 1, actionNonce: 1 });
    expect(ix.keys).toHaveLength(29);
    expect(ix.keys.at(-2)?.isSigner).toBe(true);
    expect(ix.keys.at(-1)?.isWritable).toBe(true);
  });

  it("builds the restored-core reconciliation bundle without a signer", () => {
    const market = deriveMarketCoreV3(instrument);
    const accounts = deriveV3ExecutionAccounts(market, key(81));
    const ix = reconcileVaultV3({ ...accounts, vault: key(82), mint: key(83), tokenProgram: key(84) });
    expect(ix.data).toEqual(Buffer.from([55]));
    expect(ix.keys).toHaveLength(30);
    expect(ix.keys[27]).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix.keys[28]).toMatchObject({ isWritable: false, isSigner: false });
    expect(ix.keys[29]).toMatchObject({ isWritable: false, isSigner: false });
    expect(() => reconcileVaultV3({ ...accounts, session: key(85), vault: key(82), mint: key(83), tokenProgram: key(84) })).toThrow("delegated session");
  });

  it("builds V3 session authorization with the full bundle and owner payer", () => {
    const market = deriveMarketCoreV3(instrument);
    const accounts = deriveV3ExecutionAccounts(market, key(82));
    const ix = authorizeTradingSessionV3({ ...accounts, session: key(83), sessionSigner: key(84) }, 1000, {
      seatIndex: 0, actions: 1, maxOrderNotional: 10, maxCumulativeNotional: 20, maximumExposure: 100, maximumOpenOrders: 4,
    });
    expect(ix.keys).toHaveLength(31);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[27]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[28]).toMatchObject({ isSigner: false, isWritable: true });
    expect(ix.keys[29]).toMatchObject({ isSigner: false, isWritable: false });
    expect(revokeTradingSessionV3({ ...accounts, session: key(83), sessionSigner: key(84) }, 0).keys).toHaveLength(30);
    expect(updateTradingSessionV3({ ...accounts, session: key(83), sessionSigner: key(84) }, 1100, {
      seatIndex: 0, actions: 1, maxOrderNotional: 10, maxCumulativeNotional: 20, maximumExposure: 100, maximumOpenOrders: 4,
    }).keys).toHaveLength(30);
    expect(closeTradingSessionV3({ ...accounts, session: key(83), sessionSigner: key(84) }, 0).keys.at(-3)).toMatchObject({ isSigner: true, isWritable: true });
  });

  it("appends the oracle snapshot read-only after session accounts", () => {
    const market = deriveMarketCoreV3(instrument);
    const accounts = deriveV3ExecutionAccounts(market, key(92));
    const ix = placeOrderV3({ ...accounts, session: key(93), oracleSnapshot: key(94), seatIndex: 0, side: "bid", quantity: 1, priceOrOffset: 10, expiresAt: 100, clientOrderId: 1, actionNonce: 1 });
    expect(ix.keys).toHaveLength(30);
    expect(ix.keys[28]).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix.keys[29]).toMatchObject({ isWritable: false, isSigner: false });
  });

  it("builds the non-delegated snapshot allocation with the canonical PDA", () => {
    const market = deriveMarketCoreV3(instrument); const snapshot = deriveOracleSnapshotV3(market);
    const ix = createOracleSnapshotV3({ core: market, snapshot, payer: key(95) });
    expect([...ix.data]).toEqual([59]);
    expect(ix.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable])).toEqual([[false, false], [false, true], [true, true], [false, false]]);
    expect(ix.keys[3].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it("keeps the snapshot read-only when funding replaces the signer meta", () => {
    const market = deriveMarketCoreV3(instrument);
    const ix = updateFundingV3({ ...deriveV3ExecutionAccounts(market, key(96)), oracleSnapshot: key(97) }, 1n, 10);
    expect(ix.keys).toHaveLength(29);
    expect(ix.keys[27]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[28]).toMatchObject({ isSigner: false, isWritable: false });
  });

  it("keeps ER order metas Pyth-free", () => {
    const market = deriveMarketCoreV3(instrument);
    const pythStorage = key(201); const pythTreasury = key(202);
    const ix = placeOrderV3({ ...deriveV3ExecutionAccounts(market, key(98)), oracleSnapshot: key(99), seatIndex: 0, side: "bid", quantity: 1, priceOrOffset: 10, expiresAt: 100, clientOrderId: 1 });
    expect(ix.keys.some((meta) => meta.pubkey.equals(pythStorage) || meta.pubkey.equals(pythTreasury))).toBe(false);
    expect(ix.keys.at(-1)).toMatchObject({ isWritable: false, isSigner: false });
  });

  it("builds the L1-only pre-delegation session allocation", () => {
    const market = deriveMarketCoreV3(instrument);
    const ix = createV3TradingSession({ core: market, authority: key(86), session: key(87), sessionSigner: key(88) }, 3);
    expect([...ix.data]).toEqual([57, 3, 0]);
    expect(ix.keys).toHaveLength(5);
    expect(ix.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable])).toEqual([
      [false, false], [true, true], [false, true], [false, false], [false, false],
    ]);
  });

  it("decodes V3 bytes without interpreting them as a V2 header", () => {
    const core = new Uint8Array(V3_MARKET_CORE_SIZE);
    core.set(Buffer.from("STKMK003")); const view = new DataView(core.buffer); view.setUint16(8, 3, true); core[10] = 1; core[11] = 1; core[12] = 4; core[371] = 2;
    view.setUint32(246, 922, true); core[250] = 1; view.setInt32(251, -6, true);
    expect(decodeV3MarketCore(core)).toMatchObject({ mode: 1, oracleValid: false, oracleFeedId: 922, oracleChannel: 1, oracleExponent: -6, riskConfigVersion: 2, protocolFeeBalance: 0n });
    const page = new Uint8Array(V3_BOOK_PAGE_SIZE);
    page.set(Buffer.from("STKBK003")); new DataView(page.buffer).setUint16(8, 3, true); page[10] = 1; page[11] = 3;
    expect(decodeV3BookPage(page)).toMatchObject({ side: 1, page: 3, nodeCount: 0 });
    expect(() => decodeV3MarketCore(new Uint8Array(V3_MARKET_CORE_SIZE))).toThrow(RangeError);
  });

  it("allows global metadata on page zero but bounds other pages locally", () => {
    const page = new Uint8Array(V3_BOOK_PAGE_SIZE);
    page.set(Buffer.from("STKBK003")); new DataView(page.buffer).setUint16(8, 3, true); page[10] = 0; page[11] = 0;
    new DataView(page.buffer).setUint32(60, V3_BOOK_SLOTS_PER_SIDE, true);
    expect(decodeV3BookPage(page)?.nodeCount).toBe(V3_BOOK_SLOTS_PER_SIDE);
    page[11] = 1;
    expect(() => decodeV3BookPage(page)).toThrow(RangeError);
  });

  it("decodes persisted V3 event records at shard boundaries", () => {
    const shard = new Uint8Array(3_244);
    shard.set(Buffer.from("STKEV003")); new DataView(shard.buffer).setUint16(8, 3, true); shard[10] = 0; shard[11] = 0;
    new DataView(shard.buffer).setUint16(44, 200, true); new DataView(shard.buffer).setBigUint64(48, 32n, true);
    expect(decodeV3EventShard(shard).records[0]).toMatchObject({ kind: 200, sequence: 32n });
  });

  it("decodes occupied seat positions using the generated V3 offsets", () => {
    const shard = new Uint8Array(8_236); shard.set(Buffer.from("STKST003")); new DataView(shard.buffer).setUint16(8, 3, true); shard[10] = 2; shard[11] = 0;
    const base = 44; shard[base] = 1; shard.fill(8, base + 1, base + 33);
    const view = new DataView(shard.buffer); view.setBigUint64(base + 72, 5n, true); view.setUint32(base + 168, 2, true);
    expect(decodeV3SeatShard(shard).positions[0]).toMatchObject({ shard: 2, slot: 0, basePosition: 5n, openOrderCount: 2 });
  });

  it("decodes the fixed L1 oracle snapshot layout", () => {
    const snapshot = new Uint8Array(ORACLE_SNAPSHOT_SIZE);
    snapshot.set(Buffer.from("STKORS03"));
    const view = new DataView(snapshot.buffer); view.setUint16(8, 3, true); snapshot[10] = 1;
    snapshot.set(key(91).toBytes(), 12); view.setUint32(44, 1435, true); snapshot[48] = 2; view.setInt32(49, -5, true);
    view.setBigInt64(53, 36982565n, true); view.setBigUint64(61, 10n, true); view.setBigUint64(69, 1700000000n, true); snapshot[85] = 1; snapshot[86] = 0; snapshot[87] = 1;
    expect(decodeOracleSnapshotV3(snapshot)).toMatchObject({ feedId: 1435, channel: 2, exponent: -5, price: 36982565n, authenticated: true });
  });
});
