/**
 * Client-side mirror of the indexer's own per-domain gap detection
 * (workers/src/market-stream.ts's `resynchronizing` flag / indexer-
 * service.ts's `resnapshot`): the market event WebSocket
 * (features/activity/use-market-events.ts) carries two independently
 * sequenced streams (l1, er) multiplexed together, and this module is the
 * pure state machine that classifies each incoming event against what
 * this client has already seen for that one domain. It never invents a
 * missed event's contents -- every anomaly it reports resolves the same
 * way: ask the server for a fresh snapshot.
 */

export type SequenceOutcome = "first" | "in_order" | "duplicate" | "gap" | "slot_regression";

interface DomainCursor {
  sequence: number;
  slot: number;
}

export interface SequenceTrackerState {
  l1: DomainCursor | null;
  er: DomainCursor | null;
}

export const INITIAL_SEQUENCE_TRACKER: SequenceTrackerState = { l1: null, er: null };

export interface SequencedEvent {
  domain: "l1" | "er";
  sequence: number;
  slot?: number;
}

export interface SequenceAdvanceResult {
  state: SequenceTrackerState;
  outcome: SequenceOutcome;
  /** Count of sequence numbers strictly between the last-seen one and this
   * event's, i.e. how many events this client never observed. Only
   * meaningful when outcome === "gap". */
  missed: number;
}

/** Advances ONE domain's cursor for one incoming event. `duplicate` covers
 * both an exact replay and a late/out-of-order re-delivery of something
 * already superseded -- either way the right response is the same: ignore
 * it, don't reprocess. `slot_regression` means a HIGHER sequence number
 * reported a LOWER slot than one already observed for this domain, which
 * can't happen on a healthy stream and is treated like a gap (force a
 * resync) rather than accepted as a valid reordering. */
export function advanceSequence(state: SequenceTrackerState, event: SequencedEvent): SequenceAdvanceResult {
  const prior = state[event.domain];
  const slot = event.slot ?? prior?.slot ?? 0;

  if (!prior) {
    return { state: { ...state, [event.domain]: { sequence: event.sequence, slot } }, outcome: "first", missed: 0 };
  }
  if (event.sequence <= prior.sequence) {
    return { state, outcome: "duplicate", missed: 0 };
  }
  if (event.slot !== undefined && event.slot < prior.slot) {
    return { state: { ...state, [event.domain]: { sequence: event.sequence, slot: prior.slot } }, outcome: "slot_regression", missed: 0 };
  }
  if (event.sequence > prior.sequence + 1) {
    return { state: { ...state, [event.domain]: { sequence: event.sequence, slot } }, outcome: "gap", missed: event.sequence - prior.sequence - 1 };
  }
  return { state: { ...state, [event.domain]: { sequence: event.sequence, slot } }, outcome: "in_order", missed: 0 };
}

/** Seeds a tracker baseline from a freshly fetched snapshot's events --
 * used both on initial load and after a gap/reconnect forces a resync.
 * Takes the MAXIMUM sequence per domain in the snapshot (snapshots are not
 * guaranteed to be sequence-ordered on the wire), and never decreases an
 * already-higher cursor the client happens to still hold locally (a
 * snapshot fetched slightly out of order with a live event must not roll
 * the cursor backwards and manufacture a false "gap" on the very next
 * event). */
export function seedFromSnapshot(state: SequenceTrackerState, events: readonly SequencedEvent[]): SequenceTrackerState {
  let next = state;
  for (const domain of ["l1", "er"] as const) {
    const highest = events
      .filter((event): event is SequencedEvent & { domain: "l1" | "er" } => event.domain === domain)
      .reduce<DomainCursor | null>((best, event) => {
        const slot = event.slot ?? 0;
        return !best || event.sequence > best.sequence ? { sequence: event.sequence, slot } : best;
      }, null);
    if (highest && (!next[domain] || highest.sequence > next[domain]!.sequence)) {
      next = { ...next, [domain]: highest };
    }
  }
  return next;
}
