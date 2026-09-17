import type { SessionCalendarStatus } from "./keeper-jobs";

/**
 * Concrete equity-market session calendar (Priority 8, Section 6). Uses
 * `Intl.DateTimeFormat` with an IANA time zone for local wall-clock time and
 * weekday -- the workerd runtime ships full ICU, so DST transitions are
 * handled by the platform rather than a hand-rolled offset table (the
 * ladder: native feature over custom code).
 *
 * `docs/pyth-ops.md` §5a: Pyth's signed `TradingStatus` takes safety
 * precedence over this calendar. `deriveTargetSessionStatus` below is the
 * single place that precedence is enforced -- the calendar itself never
 * knows about Pyth, and a caller can't accidentally skip the override by
 * calling `sessionCalendarStatus` directly for a keeper decision.
 */

export interface CalendarConfig {
  /** IANA time zone, e.g. "America/New_York". */
  timeZone: string;
  /** "HH:MM" local wall-clock times. */
  preMarketOpen: string;
  regularOpen: string;
  regularClose: string;
  postMarketClose: string;
  /** Full-day holidays, as local "YYYY-MM-DD" dates. */
  holidays: readonly string[];
  /** Early-close override: local date -> local "HH:MM" close time (e.g. day before Thanksgiving). */
  earlyCloses: Readonly<Record<string, string>>;
}

export type PythTradingStatus = "open" | "halted" | "corp-action" | "closed";

function partsFor(config: CalendarConfig, nowMs: number): { date: string; weekday: string; minutesOfDay: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // hour12: false can format midnight as "24"; normalize to 0.
  const hour = Number(parts.hour) % 24;
  return { date, weekday: parts.weekday, minutesOfDay: hour * 60 + Number(parts.minute) };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** The calendar's own view, with no Pyth involvement. */
export function sessionCalendarStatus(config: CalendarConfig, nowMs: number): SessionCalendarStatus {
  const { date, weekday, minutesOfDay } = partsFor(config, nowMs);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  if (config.holidays.includes(date)) return "holiday";
  const close = minutesOf(config.earlyCloses[date] ?? config.regularClose);
  const preOpen = minutesOf(config.preMarketOpen);
  const regularOpen = minutesOf(config.regularOpen);
  const postClose = minutesOf(config.postMarketClose);
  if (minutesOfDay >= regularOpen && minutesOfDay < close) return "regular";
  if ((minutesOfDay >= preOpen && minutesOfDay < regularOpen) || (minutesOfDay >= close && minutesOfDay < postClose)) return "extended";
  return "closed"; // overnight
}

/**
 * Final target status a keeper should act on: administrator override wins
 * outright; otherwise a signed Pyth Halted/CorpAction status overrides the
 * calendar (never the reverse); otherwise the calendar's own view applies.
 */
export function deriveTargetSessionStatus(
  config: CalendarConfig,
  nowMs: number,
  pythTradingStatus?: PythTradingStatus,
  administratorOverride?: SessionCalendarStatus,
): SessionCalendarStatus {
  if (administratorOverride) return administratorOverride;
  if (pythTradingStatus === "halted" || pythTradingStatus === "corp-action") return "holiday"; // no new exposure
  return sessionCalendarStatus(config, nowMs);
}

/** `state.rs::MarketMode` -> `keeper-jobs.ts`'s 'open'/'close-only'/'paused' vocabulary. `Emergency` maps conservatively to 'paused': a keeper must never try to trade a market out of an emergency halt on its own. */
export function currentModeFor(marketMode: number): "open" | "close-only" | "paused" {
  return marketMode === 1 ? "open" : marketMode === 2 ? "close-only" : "paused";
}
