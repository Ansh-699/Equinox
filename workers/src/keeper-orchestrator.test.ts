import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";
import { DeterministicTestSigner } from "./signer";
import { ProtocolRepository, TxAttemptRepository, ExecutionStatusRepository } from "./repositories";
import {
  cleanupKeeperBuilder,
  fundingKeeperBuilder,
  liquidationKeeperBuilder,
  magicBlockCommitKeeperBuilder,
  pythKeeperBuilder,
  sessionKeeperBuilder,
  meta,
  reconcileVaultInstruction,
  type KeeperTransactionContext,
} from "./transactions";
import { ProtocolKeeperOrchestrator, type OrchestratorBuilders } from "./keeper-orchestrator";
import type { FundingPolicy } from "./funding-source";
import type { CalendarConfig } from "./session-calendar";

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.DB!;
beforeAll(async () => { await applyD1Migrations(db, bindings.TEST_MIGRATIONS); });

const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** `KeeperTransactionContext.market` must be a valid base58 Solana address
 * (it gets wrapped in `address(...)` when building instructions) -- a
 * human-readable test label like "market-foo-<uuid>" is not one. */
function fakeMarketAddress(): string {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
}
const MARKET_ACCOUNT_SIZE = 512 + 90_640 + 90_640 + 128 * 256 + 64 * 128;
const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function writeI128(bytes: Uint8Array, offset: number, value: bigint) {
  let v = value < 0n ? (1n << 128n) + value : value;
  for (let i = 0; i < 16; i += 1) { bytes[offset + i] = Number(v & 0xffn); v >>= 8n; }
}

function marketAccountFixture(opts: {
  mode?: number;
  oracleValid?: boolean;
  markPrice?: bigint;
  lastFundingTimestamp?: bigint;
  fundingAccumulator?: bigint;
  authority: string;
  seats?: Array<{ index: number; basePosition: bigint; quoteEntryValue: bigint; availableCollateral: bigint; sequence?: bigint }>;
}): Uint8Array {
  const bytes = new Uint8Array(MARKET_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("STKMRK01"), 0);
  view.setUint16(8, 2, true);
  view.setUint8(10, 1);
  view.setUint8(11, opts.mode ?? 1);
  bytes.set(getBase58Encoder().encode(opts.authority), 12);
  bytes.set(getBase58Encoder().encode(opts.authority), 76); // emergency authority == keeper for test simplicity
  view.setUint16(194, 1_000, true); // maintenance margin bps
  view.setBigInt64(270, opts.fundingAccumulator ?? 0n, true);
  view.setBigUint64(286, opts.lastFundingTimestamp ?? 0n, true);
  view.setUint8(294, opts.oracleValid === false ? 0 : 1);
  view.setBigInt64(295, opts.markPrice ?? 100_000n, true);
  view.setBigUint64(303, 1_700_000_000n, true);
  for (const seat of opts.seats ?? []) {
    const start = TRADER_SEAT_OFFSET + seat.index * TRADER_SEAT_SIZE;
    bytes[start + 0] = 1;
    writeI128(bytes, start + 40, seat.availableCollateral);
    writeI128(bytes, start + 72, seat.basePosition);
    writeI128(bytes, start + 88, seat.quoteEntryValue);
    new DataView(bytes.buffer).setBigUint64(start + 176, seat.sequence ?? 1n, true);
  }
  return bytes;
}

function mockRpc(handlers: Record<string, (params: unknown[]) => unknown>): typeof fetch {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected RPC method ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handler(body.params) }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function accountRpc(byPda: Record<string, Uint8Array>, extra: Record<string, (params: unknown[]) => unknown> = {}) {
  return mockRpc({
    getMultipleAccounts: (params) => {
      const [addresses] = params as [string[]];
      return { context: { slot: 1 }, value: addresses.map((a) => (byPda[a] ? { data: [bytesToBase64(byPda[a]), "base64"], owner: PROGRAM, lamports: 1 } : null)) };
    },
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: "bh1", lastValidBlockHeight: 1_000_000 } }),
    sendTransaction: () => "sig-1",
    getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }),
    ...extra,
  });
}

async function insertMarket(symbol: string, marketPda: string, status = "active") {
  await db
    .prepare(
      `INSERT INTO markets (symbol, market_index, status, oracle_feed_id, updated_at, instrument_id, market_pda, vault_pda, session_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET market_pda=excluded.market_pda, status=excluded.status`,
    )
    .bind(symbol, Math.floor(Math.random() * 1_000_000), status, "feed-1", Date.now(), "instrument-1", marketPda, "vault-1", "regular")
    .run();
}

function buildersFor(programAddress: string, authority: string) {
  return (marketPda: string): OrchestratorBuilders => {
    const context: KeeperTransactionContext = { programAddress, market: marketPda, authority };
    return {
      pyth: pythKeeperBuilder({ ...context, oracleAccounts: [meta(authority)], ed25519Instruction: reconcileVaultInstruction(programAddress, [meta(authority)]) }),
      commit: magicBlockCommitKeeperBuilder(context),
      funding: fundingKeeperBuilder(context),
      session: sessionKeeperBuilder(context),
      cleanup: cleanupKeeperBuilder({ ...context, seatIndex: 0 }),
      liquidation: liquidationKeeperBuilder(context),
    };
  };
}

async function orchestratorFor(fetcher: typeof fetch, opts: { withSigner?: boolean; withPyth?: boolean } = {}) {
  const signer = opts.withSigner === false ? null : new DeterministicTestSigner("orchestrator-test");
  const authority = signer ? getBase58Decoder().decode(await signer.publicKey()) : "SysvarRent111111111111111111111111111111111";
  const l1 = new SolanaL1Transport("https://l1.test", fetcher);
  const er = new MagicRouterTransport("https://er.test", fetcher);
  const fundingPolicy: FundingPolicy = { intervalMs: 3_600_000, capBps: 50, scale: 1_000_000n };
  const calendar: CalendarConfig = { timeZone: "UTC", preMarketOpen: "00:00", regularOpen: "00:00", regularClose: "23:59", postMarketClose: "23:59", holidays: [], earlyCloses: {} };
  return { l1, er, signer, authority, fundingPolicy, calendar, buildersFor: buildersFor(PROGRAM, authority) };
}

describe("ProtocolKeeperOrchestrator (real Miniflare D1 + mock JSON-RPC)", () => {
  it("discovers active markets from D1 and decodes their authoritative on-chain state", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("DISC", marketPda);
    const probe = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: probe.authority }) });
    const setup = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: setup.l1, er: setup.er, signer: setup.signer, buildersFor: setup.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: setup.fundingPolicy, now: () => Date.now(), holder: "test-discover",
    });
    const summary = await orchestrator.run();
    expect(summary.leaseAcquired).toBe(true);
    expect(summary.marketsDiscovered).toBeGreaterThanOrEqual(1);
    expect(summary.results.some((r) => r.marketPda === marketPda)).toBe(true);
  });

  it("a not-yet-due funding job submits nothing", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("FUNDA", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: setup.authority, lastFundingTimestamp: BigInt(Math.floor(Date.now() / 1000)) }) });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test",
      limits: { maxMarkets: 10, maxLiquidationCandidatesPerMarket: 4, cleanupSweepBudget: 8 },
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.funding?.ran).toBe(false);
    expect((fetcher as ReturnType<typeof vi.fn>)).toBeDefined();
  });

  it("a due session transition builds a fresh transaction, submits, confirms, and the attempt persists", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("SESS", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: setup.authority, mode: 0 /* paused on-chain, calendar says regular -> should transition to open */ }) });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map([[marketPda, s2.calendar]]), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-session",
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.session?.ran).toBe(true);
    expect(market?.session?.signature).toBe("sig-1");
    const attempts = await new TxAttemptRepository(db).recentForMarket(marketPda, "session", 5);
    expect(attempts.some((a) => a.status === "confirmed")).toBe(true);
  });

  it("Pyth reports configuration_blocked with no API key, without submitting or crashing the scheduler", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("PYTHB", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: setup.authority }) });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-pyth",
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.pyth?.ran).toBe(false);
    expect(market?.pyth?.reason).toMatch(/configuration_blocked/);
  });

  it("a missing signer prevents submission on every job but still allows discovery/health reporting", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("NOSIG", marketPda);
    const setup = await orchestratorFor(mockRpc({}), { withSigner: false });
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: setup.authority }) });
    const s2 = await orchestratorFor(fetcher, { withSigner: false });
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: null, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map([[marketPda, s2.calendar]]), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-nosigner",
    });
    const summary = await orchestrator.run();
    expect(summary.marketsDiscovered).toBe(1);
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.session?.ran).toBe(false);
    expect(market?.funding?.ran).toBe(false);
    expect(market?.cleanup?.ran).toBe(false);
  });

  it("one market failing to decode does not abort another market in the same invocation", async () => {
    const goodPda = fakeMarketAddress();
    const brokenPda = fakeMarketAddress();
    await insertMarket("GOOD", goodPda);
    await insertMarket("BROKEN", brokenPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({ [goodPda]: marketAccountFixture({ authority: setup.authority }) }); // brokenPda has no entry -> null account
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-partial",
    });
    const summary = await orchestrator.run();
    expect(summary.discoveryErrors.some((e) => e.marketPda === brokenPda)).toBe(true);
    expect(summary.results.some((r) => r.marketPda === goodPda)).toBe(true);
  });

  it("lease fencing: a concurrent holder cannot run while the lease is held", async () => {
    await insertMarket("LEASE", fakeMarketAddress());
    const repo = new ProtocolRepository(db);
    const now = Date.now();
    const held = await repo.acquire("scheduler:keepers", "other-holder", 60_000, now);
    expect(held).not.toBeNull();
    const setup = await orchestratorFor(mockRpc({}));
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: setup.l1, er: setup.er, signer: setup.signer, buildersFor: setup.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: setup.fundingPolicy, now: () => now + 1, holder: "this-holder",
    });
    const summary = await orchestrator.run();
    expect(summary.leaseAcquired).toBe(false);
    if (held) await repo.release(held);
  });

  it("a liquidatable seat is discovered, re-validated, and liquidated", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("LIQ", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({
      [marketPda]: marketAccountFixture({
        authority: setup.authority, markPrice: 10n,
        seats: [{ index: 0, basePosition: 10n, quoteEntryValue: 1_000n, availableCollateral: 5n }],
      }),
    });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-liq",
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.liquidations.some((l) => l.ran)).toBe(true);
  });

  it("a healthy seat flagged by scanning is re-validated and not liquidated", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("HEALTHY", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({
      [marketPda]: marketAccountFixture({
        authority: setup.authority, markPrice: 100_000n,
        seats: [{ index: 1, basePosition: 0n, quoteEntryValue: 0n, availableCollateral: 1_000n }],
      }),
    });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-healthy",
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.liquidations.some((l) => l.ran)).toBe(false);
  });

  it("commit is skipped for an undelegated market rather than submitted every tick", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("COMMITND", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: setup.authority }) });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => Date.now(), holder: "test-commit",
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.commit?.ran).toBe(false);
    expect(market?.commit?.reason).toMatch(/not delegated/);
  });

  it("commit runs once for a delegated market with a fresh ER sequence and does not report ER-accepted as L1-finalized", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("COMMITD", marketPda);
    await new ExecutionStatusRepository(db).set(marketPda, "er_active", { erEventSequence: 7, erMarketStateSequence: 0, requestedCommitSequence: 0, l1ObservedCommitSequence: 0, l1FinalizedCommitSequence: 0, undelegationSequence: 0, restorationSequence: 0 }, null, Date.now());
    const setup = await orchestratorFor(mockRpc({}));
    const now = Date.now();
    // lastFundingTimestamp pinned to "now" so the funding job is NOT due --
    // otherwise a due funding update would itself be a legitimate explicit
    // commit trigger and this test would no longer isolate the "no trigger"
    // case it's meant to cover.
    const fetcher = accountRpc({ [marketPda]: marketAccountFixture({ authority: setup.authority, lastFundingTimestamp: BigInt(Math.floor(now / 1000)) }) });
    const s2 = await orchestratorFor(fetcher);
    const orchestrator = new ProtocolKeeperOrchestrator({
      db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
      calendars: new Map(), fundingPolicy: s2.fundingPolicy, now: () => now, holder: "test-commit-deleg",
    });
    const summary = await orchestrator.run();
    const market = summary.results.find((r) => r.marketPda === marketPda);
    // With erEventSequence (7) > lastConfirmedSequence (0) and no explicit
    // trigger (funding not due, no liquidation, no session transition, no
    // withdrawal), the policy reports observe-only, not a submitted commit
    // -- it must never assume the automatic cadence needs help without a
    // concrete trigger.
    expect(market?.commit?.ran).toBe(false);
    expect(market?.commit?.reason).toMatch(/automatic commit cadence/);
  });

  it("a duplicate scheduled invocation for the same due job does not resubmit once on-chain state reflects the first submission (idempotent)", async () => {
    const marketPda = fakeMarketAddress();
    await insertMarket("DUP", marketPda);
    const setup = await orchestratorFor(mockRpc({}));
    // Pinned to a Monday at 12:00 UTC (regular trading hours for this
    // test's UTC calendar, regularOpen 00:00 - regularClose 23:59) rather
    // than Date.now(): sessionCalendarStatus treats Sat/Sun as "closed"
    // regardless of time of day, which made this test's target transition
    // (and therefore its whole idempotency assertion) depend on which day
    // of the real week it happened to run -- it deterministically failed
    // on a weekend, since "closed" -> targetMode "close-only" (mode 2),
    // not the "open" (mode 1) this test's mock hardcodes on submission.
    const now = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21 is a Monday
    // Stateful mock: the account starts Paused; once a transaction is sent
    // (the session keeper's transition-to-open), subsequent reads reflect
    // Open -- simulating a real chain applying the submitted instruction,
    // which is what real idempotency across ticks actually depends on
    // (sessionTransitionFor seeing the *new* on-chain mode and deciding
    // there is nothing left to do), not a static fixture.
    let mode = 0;
    const sendTransaction = vi.fn(() => { mode = 1; return "sig-dup-1"; });
    const fetcher = mockRpc({
      getMultipleAccounts: () => ({
        context: { slot: 1 },
        value: [{ data: [bytesToBase64(marketAccountFixture({ authority: setup.authority, mode, lastFundingTimestamp: BigInt(Math.floor(now / 1000)) })), "base64"], owner: PROGRAM, lamports: 1 }],
      }),
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: "bh1", lastValidBlockHeight: 1_000_000 } }),
      sendTransaction: () => sendTransaction(),
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }),
    });
    const s2 = await orchestratorFor(fetcher);
    const build = () =>
      new ProtocolKeeperOrchestrator({
        db, l1: s2.l1, er: s2.er, signer: s2.signer, buildersFor: s2.buildersFor, pythSource: null,
        calendars: new Map([[marketPda, s2.calendar]]), fundingPolicy: s2.fundingPolicy, now: () => now, holder: `test-dup-${crypto.randomUUID()}`,
        // Isolate this test to the session job's own idempotency: with no
        // order-book decoder (documented ponytail limitation), the cleanup
        // job would otherwise always attempt its own bounded sweep too.
        limits: { cleanupSweepBudget: 0 },
      });
    const first = await build().run();
    const second = await build().run();
    const m1 = first.results.find((r) => r.marketPda === marketPda);
    const m2 = second.results.find((r) => r.marketPda === marketPda);
    expect(m1?.session?.ran).toBe(true);
    expect(m2?.session?.ran).toBe(false); // already transitioned to open; nothing left to do
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});
