import { describe, expect, it } from "vitest";
import {
  eventBadge,
  fromUtcInput,
  toUtcInput,
  utcDates,
  utcLock,
  utcLong,
} from "./calendar-words";

const d = (iso: string) => new Date(iso);

describe("calendar words (M8 Task 5)", () => {
  it("utcDates gives the weekend's days, with the month once when it's one month", () => {
    expect(utcDates(d("2026-03-27T02:30:00Z"), d("2026-03-29T07:00:00Z"))).toBe(
      "27–29 Mar",
    );
    expect(utcDates(d("2026-10-30T18:30:00Z"), d("2026-11-01T22:00:00Z"))).toBe(
      "30 Oct – 1 Nov",
    );
    expect(utcDates(null, null)).toBe("–");
  });

  it("utcLock and utcLong say the lock in UTC", () => {
    expect(utcLock(d("2026-10-31T20:00:00Z"))).toBe("Sat 20:00");
    expect(utcLong(d("2026-10-31T20:00:00Z"))).toBe("Sat 31 Oct, 20:00 UTC");
  });

  it("toUtcInput and fromUtcInput round-trip a datetime-local value in UTC", () => {
    expect(toUtcInput(d("2026-10-31T20:05:00Z"))).toBe("2026-10-31T20:05");
    expect(fromUtcInput("2026-10-31T20:05")).toEqual(d("2026-10-31T20:05:00Z"));
    expect(fromUtcInput("not a time")).toBeNull();
  });

  it("eventBadge names the event's state, the next one live", () => {
    const now = d("2026-10-20T00:00:00Z");
    const later = d("2026-10-31T20:00:00Z");
    const past = d("2026-10-01T20:00:00Z");
    expect(
      eventBadge({ status: "cancelled", lockAt: later }, now, false),
    ).toEqual({ label: "Cancelled", tone: "caution" });
    expect(
      eventBadge({ status: "completed", lockAt: past }, now, false),
    ).toEqual({ label: "Completed", tone: "neutral" });
    expect(
      eventBadge({ status: "scheduled", lockAt: past }, now, false),
    ).toEqual({ label: "Locked", tone: "neutral" });
    expect(
      eventBadge({ status: "scheduled", lockAt: later }, now, true),
    ).toEqual({ label: "Next", tone: "live" });
    expect(
      eventBadge({ status: "scheduled", lockAt: later }, now, false),
    ).toEqual({ label: "Scheduled", tone: "neutral" });
  });
});
