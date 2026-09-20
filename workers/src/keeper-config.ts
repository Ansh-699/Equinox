import { STOCKSTREAM_PROGRAM_ID } from "../../clients/stockstream/src/constants";
import { loadMarketRegistry } from "./active-markets";
import { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";
import type { OrchestratorBuilders, OrchestratorDeps } from "./keeper-orchestrator";
import type { CalendarConfig } from "./session-calendar";
import type { FundingPolicy } from "./funding-source";
import {
  cleanupKeeperBuilder,
  fundingKeeperBuilder,
  liquidationKeeperBuilder,
  magicBlockCommitKeeperBuilder,
  meta,
  pythKeeperBuilder,
  reconcileVaultInstruction,
  sessionKeeperBuilder,
  type KeeperTransactionContext,
} from "./transactions";
import type { Signer } from "./signer";
import { resolveKeeperSigning, type KeeperSigningResolution } from "./keeper-signer";
import { createLivePythUpdateSource, pythSourceHealth, type PythProClientConfig } from "./pyth-source";
import type { PythLazerPool } from "./pyth-lazer-client";

/**
 * Configuration classification and fail-safe wiring for the production
 * scheduled keeper path (Priority 8, Section 12).
 *
 * REQUIRED for the general Worker (ingestion, auth, public API): D1,
 * Durable Object, network, program ID, RPC endpoint -- none of that is
 * this module's concern; `index.ts`'s existing routes already gate on
 * `env.DB`/`env.SOLANA_RPC_URL` independently of keepers.
 *
 * REQUIRED only for a specific keeper job: `PYTH_PRO_API_KEY` (Pyth job),
 * a keeper signing secret (submission for every job), `MAGIC_ROUTER_URL`
 * (ER-domain jobs). Missing any one of these must degrade only the jobs
 * that need it -- never crash ingestion, auth, or the public API, and
 * (Section 12) a missing signer must still allow discovery/health
 * reporting, only submission is blocked.
 */

export type KeeperHealthState =
  | "ready"
  | "idle"
  | "configuration_blocked"
  | "lease_contended"
  | "running"
  | "retrying"
  | "dead_lettered"
  | "unhealthy";

export interface KeeperConfigHealth {
  /** Credential and endpoint presence; entitlement is verified only when
   * the live pool successfully subscribes to the configured feed. */
  pyth: KeeperHealthState;
  /** No keeper-signing secret binding exists in this deployment's `Env`
   * yet (`signer.ts::createProductionSigner` requires one) -- submission
   * is disabled for every job until one is provisioned; discovery,
   * reconciliation, and health reporting are unaffected. */
  signer: KeeperHealthState;
  magicRouter: KeeperHealthState;
}

/** Credential-presence classification for the health endpoint. The live
 * Lazer subscription is implemented (`pyth-lazer-client.ts`); "ready"
 * therefore requires the real redundancy floor: a key plus all three
 * documented endpoints. */
export function classifyKeeperConfiguration(env: Env): KeeperConfigHealth {
  const endpoints = (env.PYTH_PRO_ENDPOINTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const pythConfig: PythProClientConfig = {
    apiKey: env.PYTH_PRO_API_KEY,
    endpoints: endpoints.length > 0 ? endpoints : DEFAULT_PYTH_PRO_ENDPOINTS,
    feedId: env.PYTH_PRO_FEED_ID ?? "",
    minChannel: env.PYTH_PRO_MIN_CHANNEL ?? "fixed_rate@200ms",
  };
  return {
    pyth: pythSourceHealth(pythConfig),
    signer: env.KEEPER_KEYPAIR_JSON && env.KEEPER_PUBLIC_KEY ? "ready" : "configuration_blocked",
    magicRouter: env.MAGIC_ROUTER_URL || env.MAGICBLOCK_RPC_URL ? "ready" : "configuration_blocked",
  };
}

/** Documented default endpoints (docs.pyth.network); overridable via
 * `PYTH_PRO_ENDPOINTS` for tests. */
export const DEFAULT_PYTH_PRO_ENDPOINTS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
] as const;

/** Default equity-market calendar applied to every discovered market until
 * a per-market calendar is stored in the registry -- NYSE-style regular/
 * extended hours, no holidays configured yet (`docs/pyth-ops.md`'s
 * holiday/early-close checklist remains an operational follow-up, not a
 * code gap: the calendar's shape already supports both). */
export const DEFAULT_CALENDAR: CalendarConfig = {
  timeZone: "America/New_York",
  preMarketOpen: "04:00",
  regularOpen: "09:30",
  regularClose: "16:00",
  postMarketClose: "20:00",
  holidays: [],
  earlyCloses: {},
};

export const DEFAULT_FUNDING_POLICY: FundingPolicy = { intervalMs: 60 * 60 * 1000, capBps: 75, scale: 1_000_000n };

function buildersFor(authority: string) {
  return (marketPda: string): OrchestratorBuilders => {
    const context: KeeperTransactionContext = { programAddress: STOCKSTREAM_PROGRAM_ID, market: marketPda, authority };
    return {
      // The Ed25519 pre-instruction is meaningful only once the live Pyth
      // pool produces a signed update. This builder remains inert unless
      // the orchestrator has a healthy pythSource and signer.
      pyth: pythKeeperBuilder({ ...context, oracleAccounts: [meta(authority)], ed25519Instruction: reconcileVaultInstruction(STOCKSTREAM_PROGRAM_ID, [meta(authority)]) }),
      commit: magicBlockCommitKeeperBuilder(context),
      funding: fundingKeeperBuilder(context),
      session: sessionKeeperBuilder(context),
      cleanup: cleanupKeeperBuilder({ ...context, seatIndex: 0 }),
      liquidation: liquidationKeeperBuilder(context),
    };
  };
}

/**
 * Builds the orchestrator's dependencies from live `Env` bindings. Returns
 * `null` only when the general-Worker requirement (an RPC endpoint) is
 * itself missing -- exactly like `runIngestionTick`'s existing gate -- not
 * when a job-specific credential (Pyth key, signer) is missing; those
 * degrade their own job instead (`signer: null`, `pythSource: null`).
 */
export async function buildOrchestratorDeps(
  env: Env,
  fetcher: typeof fetch,
  signer: Signer | null,
  keeperPublicKey: string | undefined,
  options: { pythPool?: PythLazerPool } = {},
): Promise<OrchestratorDeps | null> {
  if (!env.DB || !env.SOLANA_RPC_URL) return null;
  const l1 = new SolanaL1Transport(env.SOLANA_RPC_URL, fetcher);
  const er = new MagicRouterTransport(env.MAGIC_ROUTER_URL ?? env.MAGICBLOCK_RPC_URL ?? env.SOLANA_RPC_URL, fetcher);
  const authority = keeperPublicKey ?? env.KEEPER_PUBLIC_KEY;
  const registry = await loadMarketRegistry(env.DB);
  const calendars = new Map(registry.map((row) => [row.marketPda, DEFAULT_CALENDAR] as const));
  // Live Pyth source only when the credential classification is ready AND
  // the (optional) live pool is wired in by the caller.
  let pythSource: OrchestratorDeps["pythSource"] = null;
  if (options.pythPool) {
    const endpoints = (env.PYTH_PRO_ENDPOINTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const config: PythProClientConfig = {
      apiKey: env.PYTH_PRO_API_KEY,
      endpoints: endpoints.length > 0 ? endpoints : [...DEFAULT_PYTH_PRO_ENDPOINTS],
      feedId: env.PYTH_PRO_FEED_ID ?? "",
      minChannel: env.PYTH_PRO_MIN_CHANNEL ?? "fixed_rate@200ms",
    };
    if (pythSourceHealth(config) === "ready") {
      pythSource = createLivePythUpdateSource(config, options.pythPool);
    }
  }
  return {
    db: env.DB,
    l1,
    er,
    signer,
    // No authority (no keeper public key configured) means no builder can
    // address a valid instruction; treat exactly like no signer.
    buildersFor: authority ? buildersFor(authority) : () => { throw new Error("no keeper public key configured"); },
    pythSource,
    calendars,
    fundingPolicy: DEFAULT_FUNDING_POLICY,
    now: () => Date.now(),
    holder: "scheduled-worker",
  };
}

/** The full LOCAL_DEVNET startup sequence: resolve the keeper signing
 * boundary (network guard, key validation, redacted failures), then build
 * the orchestrator deps with the validated signer. The resolution is
 * returned even when signing is disabled so the caller can report the
 * exact startup state (`observation-only` / `signer-ready` /
 * `signer-invalid` / `configuration-blocked`). */
export async function startKeeperRuntime(
  env: Env,
  fetcher: typeof fetch,
  pythPool?: PythLazerPool,
): Promise<{ resolution: KeeperSigningResolution; deps: Awaited<ReturnType<typeof buildOrchestratorDeps>> | null }> {
  const resolution = await resolveKeeperSigning(env);
  const deps = await buildOrchestratorDeps(env, fetcher, resolution.signer, env.KEEPER_PUBLIC_KEY, { pythPool });
  return { resolution, deps };
}
