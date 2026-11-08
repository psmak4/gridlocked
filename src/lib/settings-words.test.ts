import { describe, expect, it } from "vitest";
import {
  dayLabel,
  monthLabel,
  TRUST_WORDS,
  trustWords,
} from "./settings-words";

describe("trust level words (ruling 51f)", () => {
  it("names each level as the brief does, with one sentence each", () => {
    expect(TRUST_WORDS.map((w) => w.name)).toEqual([
      "New",
      "Basic",
      "Member",
      "Regular",
    ]);
    for (const { name, allows } of TRUST_WORDS) {
      expect(allows.startsWith(`${name} means `)).toBe(true);
      // One sentence: a single full stop, at the end.
      expect(allows.match(/\./g)).toHaveLength(1);
      expect(allows.endsWith(".")).toBe(true);
    }
  });

  it("reads a level, and treats anything else as New", () => {
    expect(trustWords(2).name).toBe("Member");
    expect(trustWords(9).name).toBe("New");
  });
});

describe("dates on the settings pages", () => {
  const now = new Date("2026-11-08T12:00:00Z");

  it("writes a day in the person's time zone, with the year only when it differs", () => {
    expect(dayLabel(new Date("2026-11-26T09:00:00Z"), "UTC", now)).toBe(
      "26 Nov",
    );
    // Late on the 25th in UTC is already the 26th in Tokyo.
    expect(dayLabel(new Date("2026-11-25T20:00:00Z"), "Asia/Tokyo", now)).toBe(
      "26 Nov",
    );
    expect(dayLabel(new Date("2027-01-03T09:00:00Z"), "UTC", now)).toBe(
      "3 Jan 2027",
    );
  });

  it("falls back to UTC for a time zone the runtime doesn't know", () => {
    expect(dayLabel(new Date("2026-11-26T09:00:00Z"), "Mars/Base", now)).toBe(
      "26 Nov",
    );
  });

  it("writes a month and year for the join date", () => {
    expect(monthLabel(new Date("2026-03-02T00:00:00Z"), "UTC")).toBe(
      "Mar 2026",
    );
  });
});
