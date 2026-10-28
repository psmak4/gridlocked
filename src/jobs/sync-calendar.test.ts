import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, ne } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedWorldWithSeats } from "../../tests/helpers/ingest-2026";
import { seedSeats2026 } from "../../tests/helpers/seats-2026";
import {
  allJobs,
  eventOfRound,
  jolpicaFixture,
  makePipeline,
} from "../../tests/helpers/pipeline-2026";
import { readFixture } from "../../tests/helpers/fixtures";
import {
  eventEntries,
  events,
  jobs,
  rawSnapshots,
  sessions,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { runDue } from "./runner";
import { enqueueCalendarSync } from "./sync-calendar";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date("2026-02-01T06:00:00.000Z");

describe("the sync_calendar handler", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock: ReturnType<typeof simulatedClock>;
  let pipeline: ReturnType<typeof makePipeline>;

  beforeEach(async () => {
    t = await createTestDb();
    clock = simulatedClock(T0);
    pipeline = makePipeline(t.db, clock);
    pipeline.serve("/ergast/f1/2026.json", jolpicaFixtureRoot());
    pipeline.serve(
      "/ergast/f1/2026/drivers.json",
      jolpicaFixture("drivers.json"),
    );
    pipeline.serve(
      "/ergast/f1/2026/constructors.json",
      jolpicaFixture("constructors.json"),
    );
  });
  afterEach(async () => {
    await t.close();
  });

  function jolpicaFixtureRoot() {
    return readFixture("jolpica/2026.json");
  }

  /** Enqueues today's sync for 2026 and runs exactly that job. */
  async function syncAt(at: Date) {
    clock.set(at);
    await enqueueCalendarSync(t.db, clock.now(), 2026);
    return runDue(t.db, clock, pipeline.handlers, {
      maxJobs: 1,
      leaseMs: 5 * MIN,
    });
  }

  const planned = async () =>
    (await allJobs(t.db)).filter((j) => j.kind !== "sync_calendar");

  it("enqueues one job per season per day", async () => {
    const a = await enqueueCalendarSync(t.db, T0, 2026);
    const b = await enqueueCalendarSync(
      t.db,
      new Date(T0.getTime() + 5 * HOUR),
      2026,
    );
    const c = await enqueueCalendarSync(
      t.db,
      new Date(T0.getTime() + DAY),
      2026,
    );
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(
      (await allJobs(t.db)).map((j) => [j.kind, j.dedupeKey, j.payload]),
    ).toEqual([
      ["sync_calendar", "sync_calendar:2026:2026-02-01", { season: 2026 }],
      ["sync_calendar", "sync_calendar:2026:2026-02-02", { season: 2026 }],
    ]);
  });

  it("from nothing: syncs the calendar, drivers and constructors, and plans every event", async () => {
    expect(await syncAt(T0)).toEqual({ ran: 1, failed: 0, lost: 0 });

    expect(pipeline.calls).toEqual([
      "/ergast/f1/2026.json",
      "/ergast/f1/2026/drivers.json",
      "/ergast/f1/2026/constructors.json",
    ]);
    const evs = await t.db.select().from(events);
    expect(evs).toHaveLength(23);

    // Expected from the sessions themselves: a poll per qualifying, sprint and
    // race, a roster check per fp2 and fp3, and four checks per race.
    const ss = await t.db.select().from(sessions);
    const count = (...kinds: string[]) =>
      ss.filter((s) => kinds.includes(s.kind)).length;
    const keys = (await planned()).map((j) => j.dedupeKey);
    expect(keys.filter((k) => k.startsWith("poll:"))).toHaveLength(
      count("qualifying", "sprint", "race"),
    );
    expect(keys.filter((k) => k.startsWith("roster:"))).toHaveLength(
      count("fp2", "fp3"),
    );
    expect(keys.filter((k) => k.startsWith("finalize:"))).toHaveLength(
      4 * count("race"),
    );
    // Sprint qualifying never gets a poll.
    const sq = ss.filter((s) => s.kind === "sprint_qualifying");
    expect(sq.length).toBeGreaterThan(0);
    for (const s of sq) {
      expect(keys.some((k) => k.includes(s.id))).toBe(false);
    }
    // One synced snapshot trail for the three calls.
    expect(await t.db.select().from(rawSnapshots)).toHaveLength(3);
  });

  it("creates the event entries from the seats", async () => {
    await syncAt(T0);
    await seedSeats2026(t.db, T0);
    await syncAt(new Date(T0.getTime() + DAY));

    const { event } = await eventOfRound(t.db, 18);
    const entries = await t.db
      .select()
      .from(eventEntries)
      .where(eq(eventEntries.eventId, event.id));
    expect(entries).toHaveLength(22);
  });

  it("a second run changes nothing", async () => {
    await seedWorldWithSeats(t.db);
    await syncAt(T0);
    const snapshot = async () =>
      JSON.stringify([
        await planned(),
        await t.db.select().from(events).orderBy(asc(events.id)),
        await t.db.select().from(sessions).orderBy(asc(sessions.id)),
        await t.db
          .select()
          .from(eventEntries)
          .orderBy(asc(eventEntries.eventId), asc(eventEntries.driverId)),
      ]);
    const first = await snapshot();
    expect((await planned()).length).toBeGreaterThan(100);
    expect(await t.db.select().from(eventEntries)).not.toEqual([]);

    expect(await syncAt(new Date(T0.getTime() + DAY))).toEqual({
      ran: 1,
      failed: 0,
      lost: 0,
    });
    expect(await snapshot()).toBe(first);
  });

  it("plans nothing for a cancelled event, or one already completed", async () => {
    await seedWorldWithSeats(t.db);
    const r1 = await eventOfRound(t.db, 1);
    const r2 = await eventOfRound(t.db, 2);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, r1.event.id));
    await t.db
      .update(events)
      .set({ status: "completed" })
      .where(eq(events.id, r2.event.id));
    await syncAt(T0);

    const ids = new Set([r1.event.id, ...r1.sessions.map((s) => s.id)]);
    for (const s of r2.sessions) ids.add(s.id);
    ids.add(r2.event.id);
    const keys = (await planned()).map((j) => j.dedupeKey);
    expect(keys.some((k) => [...ids].some((id) => k.includes(id)))).toBe(false);
    expect(keys.length).toBeGreaterThan(100);
  });

  it("fails for the runner's retry when Jolpica is down", async () => {
    pipeline.serve("/ergast/f1/2026.json", () => {
      throw new TypeError("fetch failed");
    });
    expect(await syncAt(T0)).toEqual({ ran: 0, failed: 1, lost: 0 });
    expect(await t.db.select().from(events)).toEqual([]);
    expect(
      (await t.db.select().from(jobs).where(ne(jobs.kind, "x"))).length,
    ).toBe(1);
  });
});
