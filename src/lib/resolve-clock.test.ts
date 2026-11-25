import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { systemClock } from "./clock";
import {
  assertClockMode,
  checkedNow,
  clockModeFromEnv,
  ClockModeError,
  createRequestNow,
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

  describe("checkedNow", () => {
    const real = new Date("2027-02-19T10:00:00Z");

    it("is the real instant on a database with a real clock", async () => {
      expect(await checkedNow(t.db, {}, real)).toEqual(real);
    });

    it("is the replay's instant on a replay database", async () => {
      await setSimulatedClock('{"at":"2026-03-06T10:00:00Z"}');
      expect(await checkedNow(t.db, { CLOCK_MODE: "replay" }, real)).toEqual(
        new Date("2026-03-06T10:00:00Z"),
      );
    });

    it("refuses a mode that isn't the database's, either way round", async () => {
      await expect(
        checkedNow(t.db, { CLOCK_MODE: "replay" }, real),
      ).rejects.toBeInstanceOf(ClockModeError);
      await setSimulatedClock('{"at":"2026-03-06T10:00:00Z"}');
      await expect(checkedNow(t.db, {}, real)).rejects.toBeInstanceOf(
        ClockModeError,
      );
    });
  });

  describe("createRequestNow", () => {
    it("checks a real-clock site's database once, not on every request", async () => {
      const now = createRequestNow(() => ({}));
      const spy = vi.spyOn(t.db, "execute");
      await now(t.db);
      await now(t.db);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("refuses a replay database on a real clock, on every request", async () => {
      await setSimulatedClock('{"at":"2026-03-06T10:00:00Z"}');
      const now = createRequestNow(() => ({}));
      await expect(now(t.db)).rejects.toBeInstanceOf(ClockModeError);
      await expect(now(t.db)).rejects.toBeInstanceOf(ClockModeError);
    });

    it("reads the replay's clock on every request", async () => {
      const now = createRequestNow(() => ({ CLOCK_MODE: "replay" }));
      await expect(now(t.db)).rejects.toBeInstanceOf(ClockModeError);
      await setSimulatedClock('{"at":"2026-03-06T10:00:00Z"}');
      expect(await now(t.db)).toEqual(new Date("2026-03-06T10:00:00Z"));
      await t.client.query(
        `update settings set value = '{"at":"2026-03-07T10:00:00Z"}' where key = 'simulated_clock'`,
      );
      expect(await now(t.db)).toEqual(new Date("2026-03-07T10:00:00Z"));
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
