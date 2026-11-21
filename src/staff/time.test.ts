import { describe, expect, it } from "vitest";
import { staffTime } from "./time";

describe("staffTime (M8)", () => {
  const now = new Date("2026-11-21T09:00:00.000Z");
  it("a day and a 24-hour time in the staff member's zone, with the year only when it differs", () => {
    expect(
      staffTime(new Date("2026-11-21T08:05:00Z"), "Europe/London", now),
    ).toBe("21 Nov, 08:05");
    expect(
      staffTime(new Date("2026-07-05T13:30:00Z"), "Europe/London", now),
    ).toBe("5 Jul, 14:30");
    expect(staffTime(new Date("2025-12-31T23:30:00Z"), "UTC", now)).toBe(
      "31 Dec 2025, 23:30",
    );
    // An unknown zone reads as UTC.
    expect(staffTime(new Date("2026-11-21T08:05:00Z"), "Mars/Base", now)).toBe(
      "21 Nov, 08:05",
    );
  });
});
