import { describe, expect, it } from "vitest";
import type { WeekendSession } from "@/play/weekend";
import { dayAndTime, ordinal, sessionRow, weekendDates } from "./weekend-words";

// Qualifying in Mexico City: 14:00 at the track, 20:00 in London.
const QUALI: WeekendSession = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "qualifying",
  label: "Qualifying",
  start: "2026-10-31T20:00:00.000Z",
  end: "2026-10-31T21:00:00.000Z",
  state: "scheduled",
  locksTeam: true,
  counts: true,
  scored: false,
  revealed: true,
};
const PRACTICE: WeekendSession = {
  ...QUALI,
  kind: "fp1",
  label: "Practice 1",
  locksTeam: false,
  counts: false,
};

const mine = { timeZone: "Europe/London", signedIn: true };
const track = { timeZone: "America/Mexico_City", signedIn: true };

describe("dayAndTime", () => {
  it("is the instant in the zone", () => {
    expect(dayAndTime(QUALI.start, "Europe/London")).toEqual({
      day: "Saturday",
      short: "Sat",
      time: "20:00",
    });
    expect(dayAndTime(QUALI.start, "America/Mexico_City").time).toBe("14:00");
  });

  it("an unknown zone is UTC", () => {
    expect(dayAndTime(QUALI.start, "Not/AZone").time).toBe("20:00");
  });
});

describe("sessionRow", () => {
  it("scheduled: the time, and Locks team on the locking session", () => {
    expect(sessionRow(QUALI, mine)).toMatchObject({
      badges: [{ tone: "neutral", label: "Locks team" }],
      sub: "Saturday · your team locks at the start",
      right: "20:00",
      rightTone: "time",
    });
    expect(sessionRow(QUALI, track).right).toBe("14:00");
    expect(sessionRow(PRACTICE, mine)).toMatchObject({
      badges: [],
      sub: "Saturday",
    });
  });

  it("tbc, live, red flag and cancelled", () => {
    expect(sessionRow({ ...PRACTICE, state: "tbc" }, mine)).toMatchObject({
      sub: "Saturday · start time not confirmed yet",
      right: "TBC",
    });
    expect(sessionRow({ ...PRACTICE, state: "live" }, mine)).toMatchObject({
      badges: [{ tone: "live", label: "Live" }],
      sub: "Saturday · on now",
    });
    expect(sessionRow({ ...PRACTICE, state: "red_flag" }, mine)).toMatchObject({
      badges: [{ tone: "caution", label: "Red flag" }],
    });
    expect(sessionRow({ ...PRACTICE, state: "cancelled" }, mine)).toMatchObject(
      { right: "Cancelled", rightTone: "muted", dashed: true },
    );
  });

  it("a scored session not seen is Hidden with Mark as watched", () => {
    const hidden = {
      ...QUALI,
      state: "ended",
      scored: true,
      revealed: false,
    } as const;
    expect(sessionRow(hidden, mine)).toMatchObject({
      sub: "Results are in · hidden until you watch",
      right: "Hidden",
      rightTone: "heat",
      markWatched: true,
    });
    // Seen: no cover, and the row says so.
    expect(sessionRow({ ...hidden, revealed: true }, mine)).toMatchObject({
      sub: "Saturday · results are in",
      right: "Ended",
      markWatched: false,
    });
    // Logged out: no watched state at all.
    expect(sessionRow(hidden, { ...mine, signedIn: false })).toMatchObject({
      right: "Ended",
      markWatched: false,
    });
  });

  it("not scored yet, or practice: ended, with nothing to watch", () => {
    expect(
      sessionRow({ ...QUALI, state: "ended", revealed: false }, mine),
    ).toMatchObject({ right: "Ended", markWatched: false });
    expect(
      sessionRow({ ...PRACTICE, state: "ended", revealed: false }, mine),
    ).toMatchObject({ sub: "Saturday", right: "Ended", markWatched: false });
  });

  it("ended early says how it was scored", () => {
    const early = {
      ...QUALI,
      kind: "race",
      label: "Race",
      locksTeam: false,
      state: "ended_early",
      scored: true,
    } as const;
    expect(sessionRow(early, mine)).toMatchObject({
      badges: [{ tone: "neutral", label: "Ended early" }],
      sub: "Saturday · results are in · scored from the official classification",
    });
  });
});

describe("weekendDates", () => {
  const at = (...isos: string[]) => isos.map((start) => ({ start }));
  it("one month, or across a month's end", () => {
    expect(
      weekendDates(at("2026-09-04T11:30:00Z", "2026-09-06T13:00:00Z"), "UTC"),
    ).toBe("4–6 Sept");
    expect(
      weekendDates(
        at("2026-10-30T18:30:00Z", "2026-11-01T20:00:00Z"),
        "America/Mexico_City",
      ),
    ).toBe("30 Oct – 1 Nov");
  });

  it("in the zone: a late session can be the next day", () => {
    expect(
      weekendDates(
        at("2026-03-06T01:30:00Z", "2026-03-08T04:00:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe("5–7 Mar");
  });
});

describe("ordinal", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [112, "112th"],
    [212, "212th"],
    [1001, "1,001st"],
  ])("%i is %s", (n, words) => {
    expect(ordinal(n)).toBe(words);
  });
});
