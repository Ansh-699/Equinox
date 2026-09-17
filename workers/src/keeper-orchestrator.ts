import type { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";
import {
  CommitRecordRepository,
  DeadLetterRepository,
  ExecutionStatusRepository,
  KeeperCursorRepository,
  OracleUpdateRepository,
  ProtocolRepository,
  TxAttemptRepository,
} from "./repositories";
import type { Signer } from "./signer";
import {
  runCleanupKeeperTick,
  runFundingKeeperTick,
  runLiquidationKeeperTick,
  runMagicBlockCommitKeeperTick,
  runMarketSessionKeeperTick,
  runPythKeeperTick,
  type CleanupKeeperInput,
  type CommitKeeperInput,
  type FundingKeeperInput,
  type KeeperDeps,
  type KeeperOutcome,
  type PythKeeperInput,
  type PythUpdateSource,
  type SessionKeeperInput,
  type TransactionBuilder,
} from "./keeper-jobs";
import { discoverActiveMarkets, type ActiveMarket, type MarketDiscoveryError } from "./active-markets";
import { currentModeFor, deriveTargetSessionStatus, type CalendarConfig, type PythTradingStatus } from "./session-calendar";
import { fundingTickDecision, type FundingPolicy } from "./funding-source";
import { scanLiquidationCandidates } from "./liquidation-discovery";
import { reReadLiquidationCandidate, toKeeperCandidate } from "./liquidation-scanner";
import { decideCommitAction } from "./commit-policy";
import { decodeMarketHeader, fetchAuthoritativeMarketAccountBytes } from "./market-state";
import type { LiquidationKeeperInput } from "./keeper-jobs";

/**
 * Concrete production keeper orchestrator (Priority 8, Section 3). Wires
 * every already-tested piece -- the six `keeper-jobs.ts` tick functions
 * (lease/idempotency/dead-letter/confirmation), the concrete
 * `transactions.ts` builders, and this session's new input sources
 * (market-state, session-calendar, funding-source, liquidation-scanner/
 * discovery, pyth-source, commit-policy) -- into one per-invocation run.
 *
 * No module-global mutable state: every dependency is passed into the
 * constructor, and `run()` derives everything else (run ID, per-market
 * results) locally.
 */

export interface OrchestratorBuilders {
  pyth: TransactionBuilder<PythKeeperInput>;
  commit: TransactionBuilder<CommitKeeperInput>;
  funding: TransactionBuilder<FundingKeeperInput>;
  session: TransactionBuilder<SessionKeeperInput>;
  cleanup: TransactionBuilder<CleanupKeeperInput>;
  liquidation: TransactionBuilder<LiquidationKeeperInput>;
}

export interface OrchestratorLimits {
  maxMarkets: number;
  maxLiquidationCandidatesPerMarket: number;
  cleanupSweepBudget: number;
}

const DEFAULT_LIMITS: OrchestratorLimits = { maxMarkets: 50, maxLiquidationCandidatesPerMarket: 8, cleanupSweepBudget: 128 };

export interface OrchestratorDeps {
  db: D1Database;
  l1: SolanaL1Transport;
  er: MagicRouterTransport;
  /** `null` when no keeper signer is configured: submission is skipped for
   * every job, but discovery/health reporting still runs (Section 12: "a
   * missing signer must prevent submission but still allow observation"). */
  signer: Signer | null;
  /** A `KeeperTransactionContext` (and therefore every builder derived from
   * it) is bound to one specific `context.market` address at construction
   * time (`transactions.ts`) -- reusing one static `OrchestratorBuilders`
   * object across every market in a multi-market run would submit every
   * transaction against whichever single market built it first. This is a
   * factory so each market gets its own correctly-addressed builder set. */
  buildersFor(marketPda: string): OrchestratorBuilders;
  /** `null` when Pyth is `configuration_blocked` (no live credential). */
  pythSource: PythUpdateSource | null;
  /** Per-market calendar config, keyed by market PDA. A market with no
   * configured calendar simply never runs the session keeper. */
  calendars: ReadonlyMap<string, CalendarConfig>;
  /** Optional live Pyth trading-status override per market, keyed by market
   * PDA -- supplied by the (not-yet-implemented) live Pyth subscription;
   * `undefined` defers entirely to the calendar. */
  pythTradingStatus?: ReadonlyMap<string, PythTradingStatus>;
  fundingPolicy: FundingPolicy;
  now: () => number;
  holder: string;
  limits?: Partial<OrchestratorLimits>;
}

export interface MarketRunResult {
  marketPda: string;
  symbol: string;
  pyth?: KeeperOutcome;
  session?: KeeperOutcome;
  funding?: KeeperOutcome;
  liquidations: KeeperOutcome[];
  cleanup?: KeeperOutcome;
  commit?: KeeperOutcome;
  error?: string;
}

export interface OrchestratorRunSummary {
  runId: string;
  leaseAcquired: boolean;
  marketsDiscovered: number;
  discoveryErrors: MarketDiscoveryError[];
  results: MarketRunResult[];
}

const SCHEDULER_LEASE_KEY = "scheduler:keepers";

export class ProtocolKeeperOrchestrator {
  private readonly limits: OrchestratorLimits;

  constructor(private readonly deps: OrchestratorDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  /**
   * One bounded scheduled invocation. Order per market: Pyth oracle update,
   * session/status transition, funding update, liquidation, cleanup,
   * MagicBlock commit/reconciliation -- funding and liquidation need the
   * freshest verified oracle state, session safety must apply before any
   * risk-increasing maintenance, and commit seals the resulting state
   * (Section 3's documented rationale). One market's failure is caught and
   * recorded, never allowed to abort the rest of the invocation.
   */
  async run(): Promise<OrchestratorRunSummary> {
    const runId = crypto.randomUUID();
    const now = this.deps.now();
    const repo = new ProtocolRepository(this.deps.db);
    const lease = await repo.acquire(SCHEDULER_LEASE_KEY, this.deps.holder, 55_000, now);
    if (!lease) return { runId, leaseAcquired: false, marketsDiscovered: 0, discoveryErrors: [], results: [] };

    try {
      const { markets, errors } = await discoverActiveMarkets(this.deps.db, this.deps.l1, this.limits.maxMarkets);
      const results: MarketRunResult[] = [];
      for (const market of markets) {
        results.push(
          await this.runMarket(market).catch((error): MarketRunResult => ({
            marketPda: market.registry.marketPda,
            symbol: market.registry.symbol,
            liquidations: [],
            error: error instanceof Error ? error.message : "unknown market failure",
          })),
        );
      }
      return { runId, leaseAcquired: true, marketsDiscovered: markets.length, discoveryErrors: errors, results };
    } finally {
      await repo.release(lease);
    }
  }

  private keeperDeps(): KeeperDeps {
    return {
      repo: new ProtocolRepository(this.deps.db),
      deadLetters: new DeadLetterRepository(this.deps.db),
      txAttempts: new TxAttemptRepository(this.deps.db),
      holder: this.deps.holder,
      now: this.deps.now,
    };
  }

  private async runMarket(market: ActiveMarket): Promise<MarketRunResult> {
    const marketPda = market.registry.marketPda;
    const result: MarketRunResult = { marketPda, symbol: market.registry.symbol, liquidations: [] };
    const keeperDeps = this.keeperDeps();
    const signer = this.deps.signer;
    const now = this.deps.now();
    const builders = this.deps.buildersFor(marketPda);

    // 1. Pyth oracle update.
    if (!this.deps.pythSource) {
      result.pyth = { ran: false, reason: "configuration_blocked: no PYTH_PRO_API_KEY configured" };
    } else if (!signer) {
      result.pyth = { ran: false, reason: "no keeper signer configured; observation only" };
    } else {
      result.pyth = await runPythKeeperTick(keeperDeps, this.deps.l1, signer, builders.pyth, this.deps.pythSource, marketPda, new OracleUpdateRepository(this.deps.db));
    }

    // 2. Session/status transition.
    const calendar = this.deps.calendars.get(marketPda);
    if (!calendar) {
      result.session = { ran: false, reason: "no session calendar configured for this market" };
    } else if (!signer) {
      result.session = { ran: false, reason: "no keeper signer configured; observation only" };
    } else {
      const targetStatus = deriveTargetSessionStatus(calendar, now, this.deps.pythTradingStatus?.get(marketPda));
      const currentMode = currentModeFor(market.state.mode);
      result.session = await runMarketSessionKeeperTick(keeperDeps, this.deps.l1, signer, builders.session, marketPda, targetStatus, currentMode);
    }

    // 3. Funding update (needs the freshest oracle state, hence after Pyth).
    const currentMode = currentModeFor(market.state.mode);
    const fundingDecision = fundingTickDecision(market.state, currentMode, this.deps.fundingPolicy, now);
    if (!fundingDecision.eligible || !fundingDecision.input) {
      result.funding = { ran: false, reason: fundingDecision.reason };
    } else if (!signer) {
      result.funding = { ran: false, reason: "no keeper signer configured; observation only" };
    } else {
      result.funding = await runFundingKeeperTick(keeperDeps, this.deps.l1, signer, builders.funding, marketPda, fundingDecision.input);
    }

    // 4. Liquidation: bounded discovery over the account bytes we already
    // hold, then an independent re-read + re-score per candidate before
    // ever building a transaction.
    const accountBytes = await fetchAuthoritativeMarketAccountBytes(this.deps.l1, marketPda);
    if (accountBytes && signer) {
      const header = decodeMarketHeader(accountBytes) ?? market.state;
      const cursors = new KeeperCursorRepository(this.deps.db);
      const stored = (await cursors.get("liquidation", marketPda)) as { seatIndex: number } | null;
      const { candidates, nextCursor } = scanLiquidationCandidates(accountBytes, header, stored?.seatIndex ?? 0, this.limits.maxLiquidationCandidatesPerMarket);
      await cursors.set("liquidation", marketPda, { seatIndex: nextCursor }, Date.now());
      for (const candidate of candidates) {
        const outcome = await runLiquidationKeeperTick(keeperDeps, this.deps.l1, signer, builders.liquidation, marketPda, toKeeperCandidate(candidate), async () => {
          const reread = await reReadLiquidationCandidate(this.deps.l1, marketPda, candidate);
          if (reread.status === "liquidatable") return reread.result;
          return { isLiquidatable: false, oracleValid: reread.status !== "stale-oracle", quantity: 0n };
        });
        result.liquidations.push(outcome);
      }
    } else if (!signer) {
      result.liquidations.push({ ran: false, reason: "no keeper signer configured; observation only" });
    }

    // 5. Expired/invalid-order cleanup.
    if (!signer) {
      result.cleanup = { ran: false, reason: "no keeper signer configured; observation only" };
    } else {
      // ponytail: no order-book arena decoder exists yet to derive a real
      // resting-order count, so the sweep budget is a configured constant
      // rather than the book's actual size. Upgrade path: decode
      // bid/ask arena occupancy once a book reader exists.
      result.cleanup = await runCleanupKeeperTick(keeperDeps, this.deps.l1, signer, builders.cleanup, marketPda, new KeeperCursorRepository(this.deps.db), this.limits.cleanupSweepBudget);
    }

    // 6. MagicBlock commit/reconciliation -- seals the resulting state.
    if (!signer) {
      result.commit = { ran: false, reason: "no keeper signer configured; observation only" };
    } else {
      result.commit = await this.runCommit(marketPda, result, signer, keeperDeps, builders);
    }

    return result;
  }

  private async runCommit(marketPda: string, marketResult: MarketRunResult, signer: Signer, keeperDeps: KeeperDeps, builders: OrchestratorBuilders): Promise<KeeperOutcome> {
    const executionStatus = new ExecutionStatusRepository(this.deps.db);
    const commitRecords = new CommitRecordRepository(this.deps.db);
    const cursors = new KeeperCursorRepository(this.deps.db);
    const now = this.deps.now();
    const stored = (await cursors.get("commit", marketPda)) as { lastTickAt: number } | null;
    const lastCommitTickAt = stored?.lastTickAt ?? 0;
    await cursors.set("commit", marketPda, { lastTickAt: now }, now);
    const persisted = await executionStatus.get(marketPda);
    const status = persisted?.status ?? "l1_only";
    const isDelegated = status !== "l1_only" && status !== "restored" && status !== "reconciliation_error";
    if (!isDelegated) return { ran: false, reason: "market is not delegated to an ephemeral rollup" };

    const sequences = (persisted?.sequences as { erEventSequence?: number; l1FinalizedCommitSequence?: number } | undefined) ?? {};
    const lastRequestedSequence = await commitRecords.lastRequestedSequence(marketPda);
    const decision = decideCommitAction({
      isDelegated,
      currentErSequence: sequences.erEventSequence ?? 0,
      lastRequestedSequence,
      lastConfirmedSequence: sequences.l1FinalizedCommitSequence ?? 0,
      openInterestChangedMaterially: false,
      fundingJustUpdated: marketResult.funding?.ran === true,
      liquidationJustHappened: marketResult.liquidations.some((l) => l.ran),
      marketJustHaltedOrCorpAction: marketResult.session?.ran === true,
      withdrawalPending: false,
      undelegationPlanned: false,
    });
    if (decision.action === "skip" || decision.action === "observe-only") return { ran: false, reason: decision.reason };

    return runMagicBlockCommitKeeperTick(
      keeperDeps,
      this.deps.er,
      signer,
      builders.commit,
      marketPda,
      commitRecords,
      sequences.erEventSequence ?? 0,
      lastCommitTickAt,
    );
  }
}
