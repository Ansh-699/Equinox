import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { SolanaL1Transport } from "./chain-transports";
import {
  PrivateSessionRepository,
  SeatOwnershipMismatch,
  issuePrivateProjectionToken,
  seatOwner,
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
