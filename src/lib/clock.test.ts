import { describe, expect, it } from "vitest";
import { fixedClock, simulatedClock, systemClock } from "./clock";

describe("fixedClock", () => {
  it("always reports the given instant", () => {
    const clock = fixedClock(new Date("2026-10-31T20:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  it("returns a copy, so mutating the result does not change the clock", () => {
    const clock = fixedClock(new Date("2026-10-31T20:00:00Z"));
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-10-31T20:00:00.000Z");
  });

  it("is not affected by later mutation of the argument", () => {
    const at = new Date("2026-10-31T20:00:00Z");
    const clock = fixedClock(at);
    at.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-10-31T20:00:00.000Z");
  });
});

describe("simulatedClock", () => {
  const start = new Date("2026-10-31T20:00:00Z");

  it("starts at the given instant", () => {
    expect(simulatedClock(start).now().toISOString()).toBe(
      "2026-10-31T20:00:00.000Z",
    );
  });

  it("advance moves now() forward by exactly the given milliseconds", () => {
    const clock = simulatedClock(start);
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe("2026-10-31T20:01:30.000Z");
    clock.advance(10);
    expect(clock.now().toISOString()).toBe("2026-10-31T20:01:30.010Z");
  });

  it("set jumps to the given instant", () => {
    const clock = simulatedClock(start);
    clock.set(new Date("2027-01-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("set copies its argument", () => {
    const clock = simulatedClock(start);
    const at = new Date("2027-01-01T00:00:00Z");
    clock.set(at);
    at.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("returns a copy, so mutating the result does not change the clock", () => {
    const clock = simulatedClock(start);
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-10-31T20:00:00.000Z");
  });

  it("copies the start argument", () => {
    const own = new Date(start);
    const clock = simulatedClock(own);
    own.setUTCFullYear(1999);
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe("2026-10-31T20:00:01.000Z");
  });
});

describe("systemClock", () => {
  it("reads real time", () => {
    const before = Date.now();
    const read = systemClock.now().getTime();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
  });
});
