import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { SolanaL1Transport } from "./chain-transports";
import {
  PrivateSessionRepository,
  SeatOwnershipMismatch,
  decodeTraderSeatProjection,
  issuePrivateProjectionToken,
  publishSeatProjection,
  seatOwner,
  seatsAffectedByEvent,
  type PrivateProjectionSink,
} from "./private-sessions";

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

const TRADER_SEAT_OFFSET = 181_792;

function accountResponse(bytes: Uint8Array, slot = 1) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value: { data: [btoa(binary), "base64"], owner: "prog", lamports: 1 } } }), { headers: { "content-type": "application/json" } });
}

function marketWithSeat(seatIndex: number, occupied: boolean, owner: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(TRADER_SEAT_OFFSET + 128 * 256);
  const start = TRADER_SEAT_OFFSET + seatIndex * 256;
  bytes[start] = occupied ? 1 : 0;
  bytes.set(owner, start + 1);
  return bytes;
}

const OWNER_BYTES = new Uint8Array(32).fill(7);
// Computed once by the module's own base58Encode over OWNER_BYTES; this is
// an internal-consistency fixture, not an independently-sourced vector (see
// the known-answer system-program test below for that).
async function transportFor(bytes: Uint8Array) {
  const fetcher: typeof fetch = vi.fn(async () => accountResponse(bytes));
  return new SolanaL1Transport("https://l1.test", fetcher);
}

it("base58-encodes 32 zero bytes as the well-known System Program address (known-answer check)", async () => {
  const transport = await transportFor(marketWithSeat(0, true, new Uint8Array(32)));
  const owner = await seatOwner(transport, "market", 0);
  expect(owner).toBe("1".repeat(32));
});

it("issues a token only when the asserted wallet actually owns the seat on-chain", async () => {
  const transport = await transportFor(marketWithSeat(2, true, OWNER_BYTES));
  const owner = (await seatOwner(transport, "market-a", 2))!;
  const repo = new PrivateSessionRepository(bindings.DB!);
  const { token } = await issuePrivateProjectionToken(repo, transport, owner, "market-a", 2, 60_000, 1_000);
  const session = await repo.verify(token, "market-a", 1_001);
  expect(session).toEqual({ wallet: owner, marketPda: "market-a", seatIndex: 2 });

  await expect(issuePrivateProjectionToken(repo, transport, "someone-else", "market-a", 2, 60_000, 1_000)).rejects.toThrow(SeatOwnershipMismatch);
});

it("rejects verification for a different market than the token was issued for", async () => {
  const transport = await transportFor(marketWithSeat(0, true, OWNER_BYTES));
  const owner = (await seatOwner(transport, "market-b", 0))!;
  const repo = new PrivateSessionRepository(bindings.DB!);
  const { token } = await issuePrivateProjectionToken(repo, transport, owner, "market-b", 0, 60_000, 1_000);
  expect(await repo.verify(token, "market-other", 1_001)).toBeNull();
  expect(await repo.verify(token, "market-b", 1_001)).not.toBeNull();
});

it("loses access immediately after revocation", async () => {
  const transport = await transportFor(marketWithSeat(0, true, OWNER_BYTES));
  const owner = (await seatOwner(transport, "market-c", 0))!;
  const repo = new PrivateSessionRepository(bindings.DB!);
  const { token } = await issuePrivateProjectionToken(repo, transport, owner, "market-c", 0, 60_000, 1_000);
  expect(await repo.verify(token, "market-c", 1_001)).not.toBeNull();
  await repo.revoke(token, 1_002);
  expect(await repo.verify(token, "market-c", 1_003)).toBeNull();
});

it("loses access once the token has expired", async () => {
  const transport = await transportFor(marketWithSeat(0, true, OWNER_BYTES));
  const owner = (await seatOwner(transport, "market-d", 0))!;
  const repo = new PrivateSessionRepository(bindings.DB!);
  const { token, expiresAt } = await issuePrivateProjectionToken(repo, transport, owner, "market-d", 0, 1_000, 1_000);
  expect(expiresAt).toBe(2_000);
  expect(await repo.verify(token, "market-d", 1_999)).not.toBeNull();
  expect(await repo.verify(token, "market-d", 2_000)).toBeNull();
});

it("returns null for an unoccupied seat rather than a false owner", async () => {
  const transport = await transportFor(marketWithSeat(0, false, OWNER_BYTES));
  expect(await seatOwner(transport, "market-e", 0)).toBeNull();
});

/** Sets every `TraderSeat` field at its verified byte offset (see
 * `SEAT_FIELD_OFFSETS` in `private-sessions.ts`, cross-checked against
 * `programs/stockstream/src/state.rs` via `core::mem::offset_of!`), on top
 * of the existing `marketWithSeat` fixture. */
function fullSeatBytes(seatIndex: number, fields: { availableCollateral: bigint; reservedMargin: bigint; basePosition: bigint; realizedPnl: bigint; openOrderCount: number; liquidationState: number; sequence: bigint }): Uint8Array {
  const bytes = marketWithSeat(seatIndex, true, OWNER_BYTES);
  const start = TRADER_SEAT_OFFSET + seatIndex * 256;
  const view = new DataView(bytes.buffer);
  const writeI128 = (offset: number, value: bigint) => {
    let v = value < 0n ? value + (1n << 128n) : value;
    for (let i = 0; i < 16; i += 1) { bytes[start + offset + i] = Number(v & 0xffn); v >>= 8n; }
  };
  writeI128(40, fields.availableCollateral);
  writeI128(56, fields.reservedMargin);
  writeI128(72, fields.basePosition);
  writeI128(104, fields.realizedPnl);
  view.setUint32(start + 168, fields.openOrderCount, true);
  bytes[start + 172] = fields.liquidationState;
  view.setBigUint64(start + 176, fields.sequence, true);
  return bytes;
}

it("decodeTraderSeatProjection decodes every seat field from its verified offset, including negative i128 values", () => {
  const bytes = fullSeatBytes(3, { availableCollateral: 1_000n, reservedMargin: 100n, basePosition: -50n, realizedPnl: -25n, openOrderCount: 2, liquidationState: 1, sequence: 9n });
  const projection = decodeTraderSeatProjection(bytes, 3);
  expect(projection).toMatchObject({
    seatIndex: 3, availableCollateral: 1_000n, reservedMargin: 100n, basePosition: -50n, realizedPnl: -25n,
    openOrderCount: 2, liquidationState: 1, sequence: 9n,
  });
  expect(projection?.owner.length).toBeGreaterThan(0);
});

it("decodeTraderSeatProjection returns null for an unoccupied seat", () => {
  const bytes = marketWithSeat(0, false, OWNER_BYTES);
  expect(decodeTraderSeatProjection(bytes, 0)).toBeNull();
});

it("seatsAffectedByEvent extracts the single seat for a seat-scoped payload, both seats for a fill, and none for a market-level event", () => {
  function payload(writer: (view: DataView) => void): string {
    const bytes = new Uint8Array(48);
    writer(new DataView(bytes.buffer));
    let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  // OrderPlaced (202): seat at [0..2].
  expect(seatsAffectedByEvent(202, payload((v) => v.setUint16(0, 5, true)))).toEqual([5]);
  // OrderFilled (204): makerSeat u32 at [0..4], takerSeat u32 at [4..8].
  expect(seatsAffectedByEvent(204, payload((v) => { v.setUint32(0, 1, true); v.setUint32(4, 2, true); }))).toEqual([1, 2]);
  // OracleUpdated (500): no seat at all.
  expect(seatsAffectedByEvent(500, payload(() => {}))).toEqual([]);
  // FundingAccumulatorUpdated (302) with NO_SEAT sentinel: market-level, no seat.
  expect(seatsAffectedByEvent(302, payload((v) => v.setUint16(0, 0xffff, true)))).toEqual([]);
});

it("publishSeatProjection resolves the live session's wallet, decodes the projection, and pushes it to the sink", async () => {
  const repo = new PrivateSessionRepository(bindings.DB!);
  const owner = (await seatOwner(await transportFor(marketWithSeat(4, true, OWNER_BYTES)), "market-proj", 4))!;
  await issuePrivateProjectionToken(repo, await transportFor(marketWithSeat(4, true, OWNER_BYTES)), owner, "market-proj", 4, 60_000, 1_000);
  const transport = await transportFor(fullSeatBytes(4, { availableCollateral: 500n, reservedMargin: 50n, basePosition: 10n, realizedPnl: 5n, openOrderCount: 1, liquidationState: 0, sequence: 1n }));
  const pushed: Array<{ wallet: string; seatIndex: number }> = [];
  const sink: PrivateProjectionSink = { publishPrivate: (wallet, seatIndex) => { pushed.push({ wallet, seatIndex }); } };
  const result = await publishSeatProjection(transport, repo, sink, "market-proj", 4, 1_500);
  expect(result).toBe(true);
  expect(pushed).toEqual([{ wallet: owner, seatIndex: 4 }]);
});

it("publishSeatProjection is a no-op when nobody currently holds a live session for the seat", async () => {
  const repo = new PrivateSessionRepository(bindings.DB!);
  const transport = await transportFor(marketWithSeat(9, true, OWNER_BYTES));
  const sink: PrivateProjectionSink = { publishPrivate: () => { throw new Error("must not be called"); } };
  expect(await publishSeatProjection(transport, repo, sink, "market-no-session", 9, 1_000)).toBe(false);
});
