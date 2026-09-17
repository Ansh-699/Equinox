import type { PythUpdateSource } from "./keeper-jobs";

/**
 * Concrete Pyth Pro client boundary (Priority 8, Section 5).
 *
 * The credential-independent part -- multi-endpoint dedup, timestamp-
 * regression rejection, and conflicting-payload quarantine (docs/pyth-ops.md
 * §5c) -- is real, pure, and tested here. The live `wss://pyth-lazer-*`
 * subscription itself (the `@pythnetwork/pyth-lazer-sdk` connection,
 * `PYTH_PRO_API_KEY`-authenticated) is deliberately NOT implemented: it
 * cannot be exercised, tested, or verified without a live credential this
 * session was told not to request, and stubbing it out to "look wired"
 * while never having run against the real service would be worse than
 * being explicit about the boundary. `pythSourceHealth` below is what the
 * scheduler checks instead of crashing or fabricating an update.
 */

export interface PythSignedUpdate {
  feedId: string;
  timestamp: number;
  payloadHash: string;
  message: Uint8Array;
  endpoint: string;
}

export type PythSourceHealth = "ready" | "configuration_blocked";

export interface PythProClientConfig {
  /** Absent (not empty-string) means "no live credential configured." */
  apiKey?: string;
  endpoints: readonly string[];
  feedId: string;
  minChannel: string;
}

/** Never throws; never returns "ready" without both a key and at least the
 * three-endpoint redundancy the Pyth docs require (docs/pyth-ops.md §1). */
export function pythSourceHealth(config: PythProClientConfig): PythSourceHealth {
  if (!config.apiKey || config.endpoints.length < 3) return "configuration_blocked";
  return "ready";
}

/**
 * Multi-endpoint agreement logic (docs/pyth-ops.md §5c), independent of any
 * live connection: given whatever updates the (currently unimplemented)
 * live subscriptions observed for a feed in one polling/dedup window,
 * decides what -- if anything -- is safe to submit on-chain.
 *
 * - Two or more endpoints reporting the *same* (feedId, timestamp,
 *   payloadHash) count once, not once per endpoint.
 * - Two endpoints reporting *different* payloads for the same
 *   (feedId, timestamp) are both quarantined -- submit nothing until
 *   resolved, per the documented rule.
 * - A timestamp at or before `lastAcceptedTimestamp` is rejected as a
 *   regression (the on-chain monotonicity check also enforces this, but
 *   this dedup must not rely on that rejection as its only guard).
 */
export function reconcileEndpointUpdates(
  updates: readonly PythSignedUpdate[],
  lastAcceptedTimestamp: number,
): { accepted: PythSignedUpdate | null; quarantined: PythSignedUpdate[]; reason: string } {
  const fresh = updates.filter((u) => u.timestamp > lastAcceptedTimestamp);
  if (fresh.length === 0) return { accepted: null, quarantined: [], reason: "no update newer than the last accepted timestamp" };

  const newestTimestamp = Math.max(...fresh.map((u) => u.timestamp));
  const atNewest = fresh.filter((u) => u.timestamp === newestTimestamp);
  const distinctHashes = new Set(atNewest.map((u) => u.payloadHash));
  if (distinctHashes.size > 1) {
    return { accepted: null, quarantined: atNewest, reason: `conflicting payloads from ${atNewest.length} endpoints for the same feed/timestamp; submitting nothing until resolved` };
  }
  return { accepted: atNewest[0], quarantined: [], reason: "endpoints agree; accepted" };
}

/**
 * Builds a `PythUpdateSource` (the interface `runPythKeeperTick` already
 * consumes) around a caller-supplied poll function -- in production this
 * would poll the live Lazer subscriptions' latest-observed-update buffers;
 * in tests it is a fixture. Returns `null` (never throws, never fabricates)
 * whenever the client is `configuration_blocked` or the poll produces
 * nothing acceptable.
 */
export function createPythUpdateSource(
  config: PythProClientConfig,
  pollEndpoints: () => Promise<readonly PythSignedUpdate[]>,
): PythUpdateSource {
  return {
    async fetchSignedUpdate(previousTimestamp) {
      if (pythSourceHealth(config) !== "ready") return null;
      const updates = await pollEndpoints();
      const { accepted } = reconcileEndpointUpdates(updates, previousTimestamp);
      if (!accepted) return null;
      return { message: accepted.message, timestamp: accepted.timestamp, payloadHash: accepted.payloadHash, feedId: accepted.feedId };
    },
  };
}
