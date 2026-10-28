import { describe, expect, it } from "vitest";
import { decideTick } from "./decide";
import { parseDueFile } from "./due-file";

const now = new Date("2026-11-01T12:00:00Z");
const fileDueAt = (at: string | null) =>
  parseDueFile(JSON.stringify({ version: 1, generated_at: "2026-11-01T11:00:00Z", next_due_at: at }));

describe("decideTick", () => {
  it("sleeps when the next due time is in the future", () => {
    expect(decideTick(fileDueAt("2026-11-01T12:00:01Z"), now)).toEqual({ action: "sleep" });
  });

  it("sleeps when nothing is due", () => {
    expect(decideTick(fileDueAt(null), now)).toEqual({ action: "sleep" });
  });

  it("wakes when the due time is exactly now", () => {
    expect(decideTick(fileDueAt("2026-11-01T12:00:00Z"), now)).toEqual({ action: "wake" });
  });

  it("wakes when the due time has passed", () => {
    expect(decideTick(fileDueAt("2026-11-01T11:59:00Z"), now)).toEqual({ action: "wake" });
  });

  it("skips, and never wakes, when the file is missing", () => {
    expect(decideTick(parseDueFile(null), now)).toEqual({ action: "skip", reason: "missing" });
  });

  it("skips, and never wakes, when the file is malformed", () => {
    expect(decideTick(parseDueFile("{}"), now)).toEqual({ action: "skip", reason: "malformed" });
  });
});
