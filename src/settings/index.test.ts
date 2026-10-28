import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { settings } from "@/db/schema";
import { getSetting } from "./index";

describe("getSetting", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it("returns the typed default when no row is stored", async () => {
    expect(await getSetting(t.db, "provider_limits")).toEqual({
      jolpica: { perSecond: 3, perHour: 400 },
      openf1: { perSecond: 2, perMinute: 25 },
    });
    expect(await getSetting(t.db, "session_durations")).toEqual({
      fp1: 60,
      fp2: 60,
      fp3: 60,
      sprint_qualifying: 45,
      qualifying: 60,
      sprint: 45,
      race: 120,
    });
    expect(await getSetting(t.db, "poll_schedule")).toEqual({
      backoffMinutes: [5, 15, 60],
      giveUpAfterHours: 24,
    });
    expect(await getSetting(t.db, "finalizer_checks")).toEqual({
      afterHours: [2, 6, 24, 48],
    });
    expect(await getSetting(t.db, "validator_thresholds")).toEqual({
      carsPerConstructor: 2,
    });
  });

  it("returns the stored value, validated, in place of the default", async () => {
    await t.db.insert(settings).values({
      key: "validator_thresholds",
      value: { carsPerConstructor: 3 },
    });
    expect(await getSetting(t.db, "validator_thresholds")).toEqual({
      carsPerConstructor: 3,
    });
  });

  it("throws on an invalid stored value instead of falling back", async () => {
    await t.db.insert(settings).values({
      key: "provider_limits",
      value: { jolpica: { perSecond: "fast" } },
    });
    await expect(getSetting(t.db, "provider_limits")).rejects.toThrow(
      /provider_limits/,
    );
  });

  it("returns a copy of the default, so a caller cannot change later results", async () => {
    const first = await getSetting(t.db, "provider_limits");
    first.jolpica.perSecond = 99;
    const poll = await getSetting(t.db, "poll_schedule");
    poll.backoffMinutes.push(999);

    expect((await getSetting(t.db, "provider_limits")).jolpica.perSecond).toBe(
      3,
    );
    expect((await getSetting(t.db, "poll_schedule")).backoffMinutes).toEqual([
      5, 15, 60,
    ]);
  });
});
