import { describe, expect, it } from "vitest";
import { nextDueFile, parseDueFile } from "./due-file";

const now = new Date("2026-11-01T12:00:00Z");

describe("parseDueFile", () => {
  it("reports a missing file", () => {
    expect(parseDueFile(null)).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["not json", "not json"],
    ["an empty object", "{}"],
    ["a different version", '{"version":2,"generated_at":"2026-11-01T12:00:00Z","next_due_at":null}'],
    ["a due time with no offset", '{"version":1,"generated_at":"2026-11-01T12:00:00Z","next_due_at":"2026-11-01 13:00:00"}'],
    ["a due time that is not a date", '{"version":1,"generated_at":"2026-11-01T12:00:00Z","next_due_at":"soon"}'],
  ])("reports %s as malformed", (_name, text) => {
    expect(parseDueFile(text)).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts a well-formed file", () => {
    const text = '{"version":1,"generated_at":"2026-11-01T12:00:00Z","next_due_at":"2026-11-01T13:00:00Z"}';
    expect(parseDueFile(text)).toEqual({
      ok: true,
      file: { version: 1, generated_at: "2026-11-01T12:00:00Z", next_due_at: "2026-11-01T13:00:00Z" },
    });
  });

  it("accepts a file with nothing due", () => {
    const text = '{"version":1,"generated_at":"2026-11-01T12:00:00Z","next_due_at":null}';
    expect(parseDueFile(text)).toMatchObject({ ok: true, file: { next_due_at: null } });
  });
});

describe("nextDueFile", () => {
  it("has no due time when nothing is pending", () => {
    expect(nextDueFile([], now)).toEqual({ version: 1, generated_at: now.toISOString(), next_due_at: null });
  });

  it("uses the earliest pending run time", () => {
    const t1 = new Date("2026-11-01T12:05:00Z");
    const t2 = new Date("2026-11-01T12:10:00Z");
    const t3 = new Date("2026-11-01T13:00:00Z");
    const file = nextDueFile([t3, t1, t2], now);
    expect(file.next_due_at).toBe(t1.toISOString());
    expect(file.generated_at).toBe(now.toISOString());
  });

  it("round-trips through parseDueFile", () => {
    const file = nextDueFile([new Date("2026-11-01T12:05:00Z")], now);
    expect(parseDueFile(JSON.stringify(file))).toEqual({ ok: true, file });
  });
});
