import { describe, expect, it } from "vitest";
import { currentModeFor, deriveTargetSessionStatus, sessionCalendarStatus, type CalendarConfig } from "./session-calendar";

const NYSE: CalendarConfig = {
  timeZone: "America/New_York",
  preMarketOpen: "04:00",
  regularOpen: "09:30",
  regularClose: "16:00",
  postMarketClose: "20:00",
  holidays: ["2026-01-01", "2026-12-25"],
  earlyCloses: { "2026-11-27": "13:00" },
};

describe("sessionCalendarStatus", () => {
  it("is regular during NYSE hours in winter (EST, UTC-5)", () => {
    // 2026-01-15 (Thursday) 14:30 UTC = 09:30 EST -> right at regular open.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 15, 14, 30))).toBe("regular");
    // 20:59 UTC = 15:59 EST -> still regular.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 15, 20, 59))).toBe("regular");
  });

  it("is regular during NYSE hours in summer (EDT, UTC-4) -- same local wall-clock time, different UTC offset", () => {
    // 2026-07-15 (Wednesday) 13:30 UTC = 09:30 EDT -> regular open.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 6, 15, 13, 30))).toBe("regular");
  });

  it("is extended before the open and after the close, closed overnight", () => {
    // 09:00 EST (winter) = 14:00 UTC -> pre-market.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 15, 14, 0))).toBe("extended");
    // 17:00 EST = 22:00 UTC -> post-market.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 15, 22, 0))).toBe("extended");
    // 02:00 EST = 07:00 UTC -> overnight, closed.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 15, 7, 0))).toBe("closed");
  });

  it("is closed on weekends", () => {
    // 2026-01-17 is a Saturday.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 17, 15, 0))).toBe("closed");
  });

  it("is a holiday on a configured full-day holiday, even during would-be regular hours", () => {
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 0, 1, 15, 0))).toBe("holiday");
  });

  it("respects an early-close override", () => {
    // 2026-11-27 (day after Thanksgiving) closes at 13:00 local instead of 16:00.
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 10, 27, 17, 30))).toBe("regular"); // 12:30 EST, still open
    expect(sessionCalendarStatus(NYSE, Date.UTC(2026, 10, 27, 18, 30))).toBe("extended"); // 13:30 EST, past the early close
  });

  it("is idempotent across repeated ticks at the same instant", () => {
    const now = Date.UTC(2026, 0, 15, 14, 30);
    expect(sessionCalendarStatus(NYSE, now)).toBe(sessionCalendarStatus(NYSE, now));
  });
});

describe("deriveTargetSessionStatus (Pyth precedence)", () => {
  const regularHours = Date.UTC(2026, 0, 15, 14, 30);

  it("defers to the calendar when Pyth reports open", () => {
    expect(deriveTargetSessionStatus(NYSE, regularHours, "open")).toBe("regular");
  });

  it("a signed Halted status overrides an otherwise-regular calendar session", () => {
    expect(deriveTargetSessionStatus(NYSE, regularHours, "halted")).toBe("holiday");
  });

  it("a signed CorpAction status overrides an otherwise-regular calendar session", () => {
    expect(deriveTargetSessionStatus(NYSE, regularHours, "corp-action")).toBe("holiday");
  });

  it("the calendar can never promote a signed halt back to open -- override always wins over calendar regardless of order", () => {
    const holiday = Date.UTC(2026, 0, 1, 15, 0);
    expect(deriveTargetSessionStatus(NYSE, holiday, "halted")).toBe("holiday");
    expect(deriveTargetSessionStatus(NYSE, regularHours, "halted")).toBe("holiday");
  });

  it("an administrator override takes precedence over both Pyth and the calendar", () => {
    expect(deriveTargetSessionStatus(NYSE, regularHours, "open", "closed")).toBe("closed");
  });
});

describe("currentModeFor", () => {
  it("maps MarketMode to the keeper vocabulary, with Emergency mapped conservatively to paused", () => {
    expect(currentModeFor(0)).toBe("paused"); // Paused
    expect(currentModeFor(1)).toBe("open"); // Open
    expect(currentModeFor(2)).toBe("close-only"); // CloseOnly
    expect(currentModeFor(3)).toBe("paused"); // Emergency
  });
});
