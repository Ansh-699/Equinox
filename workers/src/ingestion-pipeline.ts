import type { AccountInfoResult, MagicBlockErTransport, SolanaL1Transport } from "./chain-transports";
import { decodeCustodyLogMessages } from "./event-decoder";
import type { AuthoritativeSnapshotFetcher } from "./indexer-service";
import { MarketIndexer, type IndexResult } from "./indexer-service";
import type { LogsNotification } from "./ws-transport";
import type { MarketDefinition, MarketSnapshot } from "./types";

/** Priority 5, Section 3: the concrete glue between the (now real)
 * WebSocket transports and the (already real) durable D1 ingestion
 * pipeline. Nothing before this module ever turned a live subscription
 * notification into a call to `MarketIndexer.ingest`. */

/**
 * Decodes and ingests every custody event carried by one `logsNotification`.
 * A `logsNotification` already contains the full log list -- no second
 * `getTransaction` round-trip is needed for the events this program
 * currently emits (see `docs/custody.md`). A transaction the cluster
 * marked failed (`err` non-null) is skipped entirely: its logs describe
 * rolled-back state.
 */
export async function ingestLogsNotification(
  indexer: MarketIndexer,
  marketPda: string,
  notification: LogsNotification,
): Promise<IndexResult[]> {
  if (notification.err) return [];
  const events = decodeCustodyLogMessages(
    notification.logs,
    notification.source,
    notification.slot,
    notification.signature,
    notification.receivedAt,
  );
  const results: IndexResult[] = [];
  // Sequential, not Promise.all: later events in the same batch depend on
  // the cursor state the previous one just advanced (or resnapshotted).
  for (const event of events) results.push(await indexer.ingest(marketPda, event));
  return results;
}

/** Minimal, honest header decode: just the two dynamic fields a
 * resnapshot needs (`docs/program-layout.md` has the full byte map).
 * `mode`: 0=Paused 1=Open 2=CloseOnly 3=Emergency (`MarketMode` in
 * `state.rs`). `global_event_sequence` is the same monotonic counter
 * `event-decoder.ts` reads out of custody logs. */
const MARKET_MODE_OFFSET = 11;
const GLOBAL_EVENT_SEQUENCE_OFFSET = 262;
const MARKET_HEADER_MIN_LEN = 270;

function decodeMode(mode: number): MarketDefinition["status"] {
  return mode === 0 ? "paused" : mode === 3 ? "restricted" : "active";
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Concrete `AuthoritativeSnapshotFetcher`: fetches the real market account
 * from the given domain's RPC transport and decodes just enough of its
 * header to repair a projection after a sequence gap. Static per-market
 * metadata (symbol, instrument, vault, oracle feed, session policy) is not
 * on-chain-derivable from raw bytes alone, so it comes from the caller's
 * own market registry, not reconstructed here.
 */
export class AccountSnapshotFetcher implements AuthoritativeSnapshotFetcher {
  constructor(
    private readonly l1: SolanaL1Transport,
    private readonly er: MagicBlockErTransport,
    private readonly marketDefinition: (marketPda: string) => MarketDefinition,
    private readonly now: () => number = Date.now,
  ) {}

  async snapshot(marketPda: string, domain: "l1" | "er"): Promise<{ sequence: number; slot: number; snapshot: MarketSnapshot }> {
    const transport = domain === "l1" ? this.l1 : this.er;
    const result: AccountInfoResult = await transport.account(marketPda);
    if (!result.value?.data) throw new Error(`market account not found: ${marketPda} (${domain})`);
    const bytes = base64ToBytes(result.value.data[0]);
    if (bytes.length < MARKET_HEADER_MIN_LEN) throw new Error("market account too short to decode");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sequence = Number(view.getBigUint64(GLOBAL_EVENT_SEQUENCE_OFFSET, true));
    const definition = { ...this.marketDefinition(marketPda), status: decodeMode(bytes[MARKET_MODE_OFFSET]) };
    const snapshot: MarketSnapshot = {
      symbol: definition.symbol,
      sequence,
      domain,
      market: definition,
      events: [],
      capturedAt: this.now(),
    };
    return { sequence, slot: result.context.slot, snapshot };
  }
}

export { MarketIndexer };
