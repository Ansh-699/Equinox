import type { MarketEvent, MarketEventKind } from "./types";

/** Priority 7: real decoding of the complete, versioned, binary StockStream
 * event ABI (`programs/stockstream/src/events.rs`) out of a transaction's
 * own program logs. `chain-transports.ts` deliberately returns raw RPC
 * results (a transport is not a trust decision); this is that trust
 * decision -- the only place raw `getTransaction`/log bytes become the
 * typed `MarketEvent`s the indexer (`indexer-service.ts`/`repositories.ts`)
 * and the public stream (`market-stream.ts`) actually consume.
 *
 * Every event is a single `sol_log_data` syscall call, surfacing as one
 * `Program data: <base64>` log line carrying exactly `EVENT_SIZE` (100)
 * bytes: a 52-byte header (discriminator, ABI version, sequence, market,
 * timestamp) followed by a fixed 48-byte payload whose shape depends on the
 * discriminator. This replaced the earlier Priority-4 custody-only text
 * format (`SS:<Kind> market=... seq=...`, `pinocchio_log`-based `Program
 * log:` lines); the program no longer emits that format at all, so this
 * decoder is the only one the live ingestion path may use. Layout mirrored
 * byte-for-byte from `events.rs` and `clients/stockstream/src/index.ts`. */

const EVENT_DATA_PREFIX = "Program data: ";
const EVENT_HEADER_SIZE = 52;
const EVENT_PAYLOAD_SIZE = 48;
const EVENT_SIZE = EVENT_HEADER_SIZE + EVENT_PAYLOAD_SIZE;

const EVENT_KIND_NAMES: Record<number, string> = {
  100: "ExchangeInitialized", 101: "ExchangeConfigUpdated", 102: "StockInstrumentRegistered",
  103: "StockInstrumentUpdated", 104: "StockInstrumentSuspended", 105: "PerpMarketCreated",
  106: "MarketRiskUpdated", 107: "MarketPaused", 108: "MarketResumed", 109: "MarketCloseOnly",
  110: "CorporateActionEntered", 111: "CorporateActionResolved", 112: "MarketClosed",
  200: "TraderSeatCreated", 201: "TraderSeatClosed", 202: "OrderPlaced", 203: "OrderPartiallyFilled",
  204: "OrderFilled", 205: "OrderCancelled", 206: "CancelAllProgress", 207: "OrderReplaced",
  208: "OrderExpired", 209: "InvalidOrderRemoved", 210: "SelfTradePrevented",
  300: "PositionChanged", 301: "MarginChanged", 302: "FundingAccumulatorUpdated", 303: "FundingSettled",
  304: "LiquidationStarted", 305: "PositionLiquidated", 306: "BankruptcyRecorded", 307: "InsuranceApplied",
  400: "VaultInitialized", 401: "CollateralDeposited", 402: "CollateralWithdrawn", 403: "ProtocolFeesChanged",
  404: "InsuranceFundChanged", 405: "BadDebtRecorded", 406: "BadDebtResolved", 407: "VaultSurplusDetected",
  408: "VaultDeficitDetected", 409: "VaultReconciled",
  500: "OracleUpdated", 501: "OracleRejected", 502: "MarketSessionChanged", 503: "TradingStatusChanged",
  504: "OracleStale", 505: "OracleRecovered",
  600: "DelegationRequested", 601: "MarketDelegated", 602: "CommitRequested", 603: "CommitSequenceChanged",
  604: "UndelegationRequested", 605: "RestorationPending", 606: "MarketRestored", 607: "DelegationErrorState",
  700: "TradingSessionAuthorized", 701: "TradingSessionLimitsUpdated", 702: "TradingSessionActionConsumed",
  703: "TradingSessionRevoked", 704: "TradingSessionClosed",
};

/** Buckets every discriminator into the pre-existing, coarser
 * `MarketEventKind` taxonomy the indexer/stream already branch on. Order/
 * fill events distinguish "book" (order lifecycle) from "fill" (an actual
 * match); everything else groups by its nearest existing bucket rather than
 * growing the public taxonomy for this pass. */
function bucketKind(discriminator: number): MarketEventKind {
  if (discriminator === 204 || discriminator === 203) return "fill";
  if (discriminator >= 200 && discriminator <= 210) return "book";
  if (discriminator === 302 || discriminator === 303) return "funding";
  if (discriminator >= 400 && discriminator <= 409) return "custody";
  if (discriminator >= 500 && discriminator <= 505) return "oracle";
  return "health";
}

export interface DecodedStockStreamEvent {
  discriminator: number;
  kind: string;
  abiVersion: number;
  sequence: number;
  market: string;
  timestamp: number;
  /** Raw 48-byte payload, base64-encoded, for category-specific decoding downstream. */
  payload: string;
}

/** A minimal, honestly-typed slice of the real `getTransaction` JSON-RPC
 * result shape (Solana's own schema has many more fields this decoder does
 * not need). */
export interface RawTransactionResult {
  slot?: number;
  meta?: { logMessages?: string[] | null; err?: unknown } | null;
  transaction?: { signatures?: string[] } | null;
}

function base64ToBytes(base64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeEventLogLine(line: string): DecodedStockStreamEvent | null {
  if (!line.startsWith(EVENT_DATA_PREFIX)) return null;
  const bytes = base64ToBytes(line.slice(EVENT_DATA_PREFIX.length).trim());
  if (!bytes || bytes.length !== EVENT_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const discriminator = view.getUint16(0, true);
  const sequenceBig = view.getBigUint64(4, true);
  if (sequenceBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    discriminator,
    kind: EVENT_KIND_NAMES[discriminator] ?? `Unknown(${discriminator})`,
    abiVersion: bytes[2],
    sequence: Number(sequenceBig),
    market: bytesToHex(bytes.subarray(12, 44)),
    timestamp: Number(view.getBigUint64(44, true)),
    payload: bytesToBase64(bytes.subarray(EVENT_HEADER_SIZE, EVENT_SIZE)),
  };
}

/**
 * Decodes every recognized StockStream event out of a raw list of program
 * log lines (shared by both entry points below: a `getTransaction`
 * result's `meta.logMessages`, and a live `logsNotification`'s
 * `value.logs`, which are the exact same strings on the wire). A line that
 * isn't a `Program data:` record, or one whose decoded length doesn't
 * match `EVENT_SIZE` (a truncated/foreign line, or one from a CPI'd
 * program), is silently skipped -- a single malformed line must never
 * abort ingestion of the rest of a batch. An *unrecognized* discriminator
 * (a future ABI addition) is still surfaced with `kind: "Unknown(<n>)"`
 * rather than dropped, so a newer program version doesn't silently blind
 * an older indexer.
 */
export function decodeCustodyLogMessages(
  logMessages: readonly string[],
  domain: "l1" | "er",
  slot: number | undefined,
  signature: string | undefined,
  observedAt: number,
): MarketEvent[] {
  const events: MarketEvent[] = [];
  for (const line of logMessages) {
    const decoded = decodeEventLogLine(line);
    if (!decoded) continue;
    const id = signature ? `${signature}:${decoded.sequence}` : `${domain}:${decoded.market}:${decoded.sequence}`;
    events.push({
      id,
      symbol: decoded.market,
      kind: bucketKind(decoded.discriminator),
      slot,
      domain,
      sequence: decoded.sequence,
      payload: {
        kind: decoded.kind,
        discriminator: decoded.discriminator,
        abiVersion: decoded.abiVersion,
        market: decoded.market,
        timestamp: decoded.timestamp,
        payload: decoded.payload,
        signature,
      },
      observedAt,
    });
  }
  return events;
}

/**
 * Decodes every recognized event out of one `getTransaction` result's
 * program logs. A transaction the runtime marked failed (`meta.err`) is
 * skipped entirely: a failed transaction's logs describe state that was
 * rolled back, so treating them as real events would apply changes that
 * never actually happened on-chain. Used by gap-recovery and any
 * historical backfill path
 * (`chain-transports.ts::SolanaL1Transport.transaction`); the live path is
 * `decodeCustodyLogMessages` called directly from a `logsNotification`
 * (see `ingestion-pipeline.ts`), since that notification already carries
 * the logs without a second RPC round-trip.
 */
export function decodeCustodyEvents(
  transaction: RawTransactionResult,
  domain: "l1" | "er",
  observedAt: number,
): MarketEvent[] {
  if (transaction.meta?.err) return [];
  return decodeCustodyLogMessages(
    transaction.meta?.logMessages ?? [],
    domain,
    transaction.slot,
    transaction.transaction?.signatures?.[0],
    observedAt,
  );
}
