import type { PythUpdateSource } from "./keeper-jobs";

/**
 * Real Pyth Pro client boundary (Priority 12).
 *
 * The live `wss://pyth-lazer-{0,1,2}` subscriptions are implemented in
 * `pyth-lazer-client.ts` (three redundant authenticated connections,
 * activity heartbeat, bounded reconnect/resubscribe, schema validation,
 * secret-free metrics) and exercised end to end against in-memory mock
 * servers there. This module keeps the pure agreement/dedup/quarantine core
 * (`docs/pyth-ops.md` §5c) and composes the live pool into the
 * `PythUpdateSource` the keeper tick consumes.
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
  // A feed name or a Hermes hash is not a valid Pyth Pro subscription ID.
  // Keep the Worker fail-closed until catalog discovery supplied the numeric
  // Lazer ID that the authenticated subscription actually accepts.
  if (!config.apiKey || config.endpoints.length < 3 || !/^\d+$/.test(config.feedId) || Number(config.feedId) <= 0)
    return "configuration_blocked";
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
 * Builds a `PythUpdateSource` around a caller-supplied poll function --
 * in production this polls the live Lazer pool's latest-observed-update
 * buffers (`createLivePythUpdateSource` below); in tests it is a fixture.
 * Returns `null` (never throws, never fabricates) whenever the client is
 * `configuration_blocked` or the poll produces nothing acceptable.
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

/**
 * The production `PythUpdateSource`: polls the live three-endpoint
 * Lazer pool and applies the same agreement rules (dedup, regression
 * rejection, conflict quarantine) to whatever the endpoints observed.
 * `redundancyHealthy()` gates submission: with two or more endpoints down
 * the source stops feeding the risk path (one endpoint may be down during
 * deployments; two down means the documented redundancy floor is broken).
 */
export function createLivePythUpdateSource(
  config: PythProClientConfig,
  pool: import("./pyth-lazer-client").PythLazerPool,
): PythUpdateSource {
  return {
    async fetchSignedUpdate(previousTimestamp, previousPayloadHash) {
      if (pythSourceHealth(config) !== "ready") return null;
      if (!pool.redundancyHealthy()) return null;
      const updates = await pool.fetchSignedUpdates();
      const { accepted } = reconcileEndpointUpdates(updates, previousTimestamp);
      if (!accepted) return null;
      // Same signed update submitted twice is forbidden (docs/pyth-ops.md
      // §5c): the durable `(timestamp, payload hash)` dedup stays
      // authoritative, this is the in-memory mirror of it.
      if (accepted.payloadHash === previousPayloadHash) return null;
      return {
        message: accepted.message,
        timestamp: accepted.timestamp,
        payloadHash: accepted.payloadHash,
        feedId: accepted.feedId,
      };
    },
  };
}
