import { describe, expect, it } from "vitest";
import { msUntil } from "./reload-at";

// The page's clock is the server's at load; the browser's own clock only
// measures how long it has been open.
const SERVER_NOW = Date.parse("2026-03-08T03:50:00Z");
const LOADED = 1_000_000;

describe("msUntil", () => {
  it("counts from the server's clock, less the time the page has been open", () => {
    expect(
      msUntil("2026-03-08T04:00:00.000Z", SERVER_NOW, LOADED, LOADED),
    ).toBe(600_000);
    expect(
      msUntil("2026-03-08T04:00:00.000Z", SERVER_NOW, LOADED, LOADED + 60_000),
    ).toBe(540_000);
  });

  it("is 0 once the moment has passed", () => {
    expect(
      msUntil("2026-03-08T04:00:00.000Z", SERVER_NOW, LOADED, LOADED + 700_000),
    ).toBe(0);
  });

  it("is null with nothing to wait for, or too far ahead for a timer", () => {
    expect(msUntil(null, SERVER_NOW, LOADED, LOADED)).toBeNull();
    expect(
      msUntil("2026-05-01T00:00:00.000Z", SERVER_NOW, LOADED, LOADED),
    ).toBeNull();
  });
});
