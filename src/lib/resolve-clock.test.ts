import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { systemClock } from "./clock";
import {
  assertClockMode,
  clockModeFromEnv,
  ClockModeError,
  resolveClock,
} from "./resolve-clock";

describe("resolveClock", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  async function setSimulatedClock(json: string) {
    await t.client.query(
      "insert into settings (key, value) values ('simulated_clock', $1::jsonb)",
      [json],
    );
  }

  describe("system mode", () => {
    it("returns the system time when no scheduledAt is given", async () => {
      const clock = await resolveClock({ mode: "system", db: t.db });
      const diff = Math.abs(
        clock.now().getTime() - systemClock.now().getTime(),
      );
      expect(diff).toBeLessThan(5000);
    });

    it("returns exactly scheduledAt without querying the database", async () => {
      const spy = vi.spyOn(t.db, "execute");
      const scheduledAt = new Date("2026-11-29T15:30:00Z");
      const clock = await resolveClock({
        mode: "system",
        db: t.db,
        scheduledAt,
      });
      expect(clock.now().getTime()).toBe(scheduledAt.getTime());
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("replay mode", () => {
    it("returns the simulated instant, fixed across calls", async () => {
      await setSimulatedClock('{"at":"2026-11-29T16:00:00Z"}');
      const clock = await resolveClock({ mode: "replay", db: t.db });
      expect(clock.now().toISOString()).toBe("2026-11-29T16:00:00.000Z");
      expect(clock.now().getTime()).toBe(clock.now().getTime());
    });

    it("honours an explicit UTC offset", async () => {
      await setSimulatedClock('{"at":"2026-11-29T17:00:00+01:00"}');
      const clock = await resolveClock({ mode: "replay", db: t.db });
      expect(clock.now().toISOString()).toBe("2026-11-29T16:00:00.000Z");
    });

    it("throws when simulated_clock is not set", async () => {
      await expect(resolveClock({ mode: "replay", db: t.db })).rejects.toThrow(
        ClockModeError,
      );
    });
  });

  describe("assertClockMode", () => {
    it("throws in system mode when simulated_clock is set", async () => {
      await setSimulatedClock('{"at":"2026-11-29T16:00:00Z"}');
      const err = await assertClockMode(t.db, "system").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ClockModeError);
      expect((err as Error).name).toBe("ClockModeError");
      expect((err as Error).message).toBe(
        "simulated_clock is set but CLOCK_MODE is system",
      );
    });

    it("throws in replay mode when simulated_clock is not set", async () => {
      const err = await assertClockMode(t.db, "replay").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ClockModeError);
      expect((err as Error).message).toBe(
        "CLOCK_MODE is replay but simulated_clock is not set",
      );
    });

    it("passes when system mode has no simulated_clock", async () => {
      await expect(assertClockMode(t.db, "system")).resolves.toBeUndefined();
    });

    it("passes when replay mode has simulated_clock", async () => {
      await setSimulatedClock('{"at":"2026-11-29T16:00:00Z"}');
      await expect(assertClockMode(t.db, "replay")).resolves.toBeUndefined();
    });
  });
});

describe("clockModeFromEnv", () => {
  it("defaults to system when CLOCK_MODE is unset", () => {
    expect(clockModeFromEnv({})).toBe("system");
  });

  it("accepts system and replay", () => {
    expect(clockModeFromEnv({ CLOCK_MODE: "system" })).toBe("system");
    expect(clockModeFromEnv({ CLOCK_MODE: "replay" })).toBe("replay");
  });

  it("throws on any other value", () => {
    expect(() => clockModeFromEnv({ CLOCK_MODE: "fake" })).toThrow();
    expect(() => clockModeFromEnv({ CLOCK_MODE: "" })).toThrow();
  });
});
