import type { MarketEvent } from "./types";

/** Priority 5: real decoding of StockStream custody events out of a
 * transaction's own program logs. `chain-transports.ts` deliberately returns
 * raw RPC results (a transport is not a trust decision); this is that trust
 * decision -- the only place raw `getTransaction`/log bytes become the typed
 * `MarketEvent`s the indexer (`indexer-service.ts`/`repositories.ts`) and the
 * public stream (`market-stream.ts`) actually consume.
 *
 * Format matches `handlers::log_custody_event` in the Rust program exactly
 * (see `docs/custody.md`): `SS:<Kind> market=<hex32> [seat=<u16>]
 * amount=<u64> seq=<u64> balance=<u64> mint=<hex32>`, emitted via
 * `pinocchio_log` and observed as a `Program log: ...` line. `seq` is
 * `header.global_event_sequence`, the market's own shared monotonic
 * sequence counter -- the same field the indexer's gap/resnapshot logic
 * (`indexer.ts::nextCursor`) keys off of. */

const CUSTODY_LOG_PREFIX = "Program log: SS:";
const CUSTODY_EVENT_PATTERN =
  /^SS:(\w+) market=([0-9a-f]{64})(?: seat=(\d+))? amount=(\d+) seq=(\d+) balance=(\d+) mint=([0-9a-f]{64})$/;

export interface DecodedCustodyEvent {
  kind: string;
  market: string;
  seat?: number;
  amount: string;
  sequence: number;
  balance: string;
  mint: string;
}

/** A minimal, honestly-typed slice of the real `getTransaction` JSON-RPC
 * result shape (Solana's own schema has many more fields this decoder does
 * not need). */
export interface RawTransactionResult {
  slot?: number;
  meta?: { logMessages?: string[] | null; err?: unknown } | null;
  transaction?: { signatures?: string[] } | null;
}

function decodeCustodyLogLine(line: string): DecodedCustodyEvent | null {
  const withoutPrefix = line.startsWith(CUSTODY_LOG_PREFIX) ? line.slice("Program log: ".length) : line;
  const match = CUSTODY_EVENT_PATTERN.exec(withoutPrefix);
  if (!match) return null;
  const sequence = Number(match[5]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return {
    kind: match[1],
    market: match[2],
    seat: match[3] !== undefined ? Number(match[3]) : undefined,
    amount: match[4],
    sequence,
    balance: match[6],
    mint: match[7],
  };
}

/**
 * Decodes every recognized custody event out of a raw list of program-log
 * lines (shared by both entry points below: a `getTransaction` result's
 * `meta.logMessages`, and a live `logsNotification`'s `value.logs`, which
 * are the exact same strings on the wire). Unrecognized log lines (from
 * CPI'd programs, `msg!` debug output elsewhere in this program, or a
 * future/older custody log shape) are silently skipped rather than
 * throwing -- a single malformed or foreign line must never abort
 * ingestion of the rest of a batch.
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
    const decoded = decodeCustodyLogLine(line);
    if (!decoded) continue;
    const id = signature ? `${signature}:${decoded.sequence}` : `${domain}:${decoded.market}:${decoded.sequence}`;
    events.push({
      id,
      symbol: decoded.market,
      kind: "custody",
      slot,
      domain,
      sequence: decoded.sequence,
      payload: {
        kind: decoded.kind,
        market: decoded.market,
        seat: decoded.seat,
        amount: decoded.amount,
        balance: decoded.balance,
        mint: decoded.mint,
        signature,
      },
      observedAt,
    });
  }
  return events;
}

/**
 * Decodes every recognized custody event out of one `getTransaction`
 * result's program logs. A transaction the runtime marked failed
 * (`meta.err`) is skipped entirely: a failed transaction's logs describe
 * state that was rolled back, so treating them as real events would apply
 * changes that never actually happened on-chain. Used by gap-recovery and
 * any historical backfill path (`chain-transports.ts::SolanaL1Transport.transaction`);
 * the live path is `decodeCustodyLogMessages` called directly from a
 * `logsNotification` (see `ingestion-pipeline.ts`), since that notification
 * already carries the logs without a second RPC round-trip.
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
