import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, ne, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedWorldWithSeats } from "../../tests/helpers/ingest-2026";
import { seedSeats2026 } from "../../tests/helpers/seats-2026";
import {
  allJobs,
  eventOfRound,
  importFixtures2026,
  jolpicaFixture,
  makePipeline,
} from "../../tests/helpers/pipeline-2026";
import { readFixture } from "../../tests/helpers/fixtures";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import {
  eventEntries,
  events,
  gameEvents,
  games,
  jobs,
  rawSnapshots,
  seasons,
  sessions,
} from "@/db/schema";
import { createGame } from "@/game/games";
import { RULESET_2026 } from "@/game/ruleset";
import { SCORING_RULES_2026 } from "@/scoring/rules";
import { simulatedClock } from "@/lib/clock";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { DUE_KEY } from "./due-times";
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
    const result = await runDue(t.db, clock, pipeline.handlers, {
      maxJobs: 1,
      leaseMs: 5 * MIN,
    });
    // The day's identity job is covered on its own below; here it would be
    // the next job a later call claims.
    await t.db.delete(jobs).where(eq(jobs.kind, "identity_daily"));
    return result;
  }

  const planned = async () =>
    (await allJobs(t.db)).filter(
      (j) => j.kind !== "sync_calendar" && j.kind !== "identity_daily",
    );

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

  it("republishes the due-times file when given a store", async () => {
    const m = createMemoryDueStore({
      [DUE_KEY]: JSON.stringify({
        version: 1,
        generated_at: T0.toISOString(),
        next_due_at: new Date(T0.getTime() + DAY).toISOString(),
      }),
    });
    await enqueueCalendarSync(t.db, T0, 2026, m.store);
    expect(JSON.parse(m.objects.get(DUE_KEY)!).next_due_at).toBe(
      T0.toISOString(),
    );

    // Already due at T0: a second call the same day writes nothing.
    m.puts.length = 0;
    await enqueueCalendarSync(t.db, T0, 2026, m.store);
    expect(m.puts).toHaveLength(0);
  });

  describe("the daily game checks", () => {
    /** A game for 2026, in the status given. */
    async function aGame(status: "setup" | "running") {
      await importFixtures2026(t.db, T0);
      const [season] = await t.db
        .select()
        .from(seasons)
        .where(eq(seasons.year, 2026));
      const { gameId } = await createGame(t.db, T0, {
        seasonId: season!.id,
        slug: "2026-fantasy",
        name: "2026 Fantasy",
        params: RULESET_2026,
        rules: SCORING_RULES_2026,
        notes: "The 2026 rules.",
      });
      await t.db.update(games).set({ status }).where(eq(games.id, gameId));
      return gameId;
    }
    const checks = async () =>
      (await allJobs(t.db)).filter((j) => j.kind === "game_checks");
    const nextSync = async () =>
      (await allJobs(t.db)).filter(
        (j) => j.dedupeKey === "sync_calendar:2026:2026-02-02",
      );

    it("queues one for each running game, due now", async () => {
      const gameId = await aGame("running");
      expect(await syncAt(T0)).toEqual({ ran: 1, failed: 0, lost: 0 });
      expect(await checks()).toMatchObject([
        {
          dedupeKey: `game_checks:${gameId}:2026-02-01`,
          runAt: T0,
          payload: { gameId },
          status: "pending",
        },
      ]);
      expect(await nextSync()).toHaveLength(1);
    });

    it("queues none for a game that isn't running", async () => {
      await aGame("setup");
      await syncAt(T0);
      expect(await checks()).toEqual([]);
    });

    it("a failing check leaves the calendar chain alone", async () => {
      const gameId = await aGame("running");
      await syncAt(T0);
      const failing = {
        ...pipeline.handlers,
        game_checks: () => Promise.reject(new Error("a check broke")),
      };
      expect(
        await runDue(t.db, clock, failing, { maxJobs: 1, leaseMs: 5 * MIN }),
      ).toEqual({ ran: 0, failed: 1, lost: 0 });
      expect(await checks()).toMatchObject([
        { dedupeKey: `game_checks:${gameId}:2026-02-01`, status: "failed" },
      ]);
      expect(await nextSync()).toMatchObject([{ status: "pending" }]);
    });

    it("the next day's sync is queued even if queueing a check fails", async () => {
      await aGame("running");
      await t.db.execute(sql`
        create function refuse_checks() returns trigger language plpgsql as $$
        begin
          raise exception 'no checks today';
        end;
        $$
      `);
      await t.db.execute(sql`
        create trigger refuse_checks before insert on jobs
        for each row when (new.kind = 'game_checks')
        execute function refuse_checks()
      `);
      expect(await syncAt(T0)).toEqual({ ran: 0, failed: 1, lost: 0 });
      expect(await nextSync()).toMatchObject([{ status: "pending" }]);
    });

    it("the handler is wired into the pipeline", () => {
      expect(pipeline.handlers).toHaveProperty("game_checks");
    });
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

  it("enqueues tomorrow's sync at 06:00 UTC, so the sync recurs", async () => {
    const at = new Date("2026-02-01T09:30:00.000Z");
    expect(await syncAt(at)).toEqual({ ran: 1, failed: 0, lost: 0 });
    const syncs = (await allJobs(t.db)).filter(
      (j) => j.kind === "sync_calendar",
    );
    expect(
      syncs.map((j) => [j.dedupeKey, j.status, j.runAt, j.payload]),
    ).toEqual([
      ["sync_calendar:2026:2026-02-01", "succeeded", at, { season: 2026 }],
      [
        "sync_calendar:2026:2026-02-02",
        "pending",
        new Date("2026-02-02T06:00:00.000Z"),
        { season: 2026 },
      ],
    ]);

    // Run again the next day: the chain continues, and nothing is duplicated.
    const next = new Date("2026-02-02T06:00:00.000Z");
    clock.set(next);
    await runDue(t.db, clock, pipeline.handlers, {
      maxJobs: 1,
      leaseMs: 5 * MIN,
    });
    expect(
      (await allJobs(t.db))
        .filter((j) => j.kind === "sync_calendar")
        .map((j) => [j.dedupeKey, j.status]),
    ).toEqual([
      ["sync_calendar:2026:2026-02-01", "succeeded"],
      ["sync_calendar:2026:2026-02-02", "succeeded"],
      ["sync_calendar:2026:2026-02-03", "pending"],
    ]);
  });

  it("a failed run enqueues no next day, so the retry does", async () => {
    pipeline.serve("/ergast/f1/2026.json", () => {
      throw new TypeError("fetch failed");
    });
    await syncAt(T0);
    expect(
      (await allJobs(t.db)).map((j) => [j.kind, j.dedupeKey, j.status]),
    ).toEqual([["sync_calendar", "sync_calendar:2026:2026-02-01", "failed"]]);
  });

  describe("after the 2026 import", () => {
    const NOW = new Date("2026-10-29T06:00:00.000Z");

    it("plans only the events still to finish, and nothing is due right away", async () => {
      await importFixtures2026(t.db, new Date("2026-10-28T09:00:00Z"));
      expect(await allJobs(t.db)).toEqual([]);

      expect(await syncAt(NOW)).toEqual({ ran: 1, failed: 0, lost: 0 });

      const evs = await t.db.select().from(events);
      const roundOf = new Map(evs.map((e) => [e.id, e.round]));
      const sessionRound = new Map(
        (await t.db.select().from(sessions)).map((s) => [
          s.id,
          roundOf.get(s.eventId)!,
        ]),
      );
      const rounds = new Set<number>();
      for (const job of await planned()) {
        const p = job.payload as { eventId?: string; sessionId?: string };
        rounds.add(
          p.eventId ? roundOf.get(p.eventId)! : sessionRound.get(p.sessionId!)!,
        );
        // Everything planned is still in the future.
        expect(job.runAt.getTime()).toBeGreaterThan(NOW.getTime());
      }
      expect([...rounds].sort((a, b) => a - b)).toEqual([19, 20, 21, 22, 23]);

      // The only job due now or earlier is the sync itself: today's has run,
      // and the next is tomorrow at 06:00.
      const syncs = (await allJobs(t.db)).filter(
        (j) => j.kind === "sync_calendar",
      );
      expect(syncs.map((j) => [j.status, j.runAt.toISOString()])).toEqual([
        ["succeeded", NOW.toISOString()],
        ["pending", "2026-10-30T06:00:00.000Z"],
      ]);
      // Imported rounds stay as the import left them.
      for (const e of evs.filter((e) => e.round <= 18)) {
        expect(e.status).toBe("scheduled");
      }
    });

    it("still plans a weekend whose last finalize check is ahead", async () => {
      await importFixtures2026(t.db, new Date("2026-10-26T09:00:00Z"));
      // Round 18's race ended 2026-10-25 22:00Z; +48 h is 2026-10-27 22:00Z.
      await syncAt(new Date("2026-10-26T06:00:00.000Z"));
      const keys = (await planned()).map((j) => j.dedupeKey);
      const finals = keys.filter((k) => k.startsWith("finalize:"));
      expect(finals.some((k) => k.endsWith("+48h"))).toBe(true);
      const { event } = await eventOfRound(t.db, 18);
      expect(finals.filter((k) => k.includes(event.id))).toEqual(
        expect.arrayContaining([`finalize:${event.id}:+48h`]),
      );
    });
  });

  it("a calendar sync plans the season's game jobs", async () => {
    await syncAt(T0);
    const [season] = await t.db.select().from(seasons);
    const { gameId } = await createGame(t.db, T0, {
      seasonId: season!.id,
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      params: RULESET_2026,
      rules: SCORING_RULES_2026,
      notes: "The 2026 rules.",
    });
    const gameJobs = async () =>
      (await allJobs(t.db)).filter((j) => j.kind.startsWith("game_"));
    expect(await gameJobs()).toEqual([]);

    await syncAt(new Date(T0.getTime() + DAY));

    // A lock job per event, and an open job per event after the first.
    const jobsNow = await gameJobs();
    const locks = jobsNow.filter((j) => j.kind === "game_lock");
    const opens = jobsNow.filter((j) => j.kind === "game_open");
    const evs = await t.db.select().from(events);
    expect(locks).toHaveLength(evs.length);
    expect(opens).toHaveLength(evs.length - 1);
    for (const event of evs) {
      expect(
        locks.find((j) => j.dedupeKey === `game_lock:${gameId}:${event.id}`),
      ).toMatchObject({ status: "pending", runAt: event.lockAt });
    }

    // A second sync moves nothing and adds nothing.
    await syncAt(new Date(T0.getTime() + 2 * DAY));
    expect(await gameJobs()).toHaveLength(jobsNow.length);
  });

  it("a cancelled event reaches the season's games at the next sync", async () => {
    await syncAt(T0);
    const [season] = await t.db.select().from(seasons);
    const { gameId } = await createGame(t.db, T0, {
      seasonId: season!.id,
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      params: RULESET_2026,
      rules: SCORING_RULES_2026,
      notes: "The 2026 rules.",
    });
    const { event } = await eventOfRound(t.db, 5);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, event.id));

    await syncAt(new Date(T0.getTime() + DAY));
    const [row] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, event.id));
    expect(row).toMatchObject({ gameId, status: "cancelled", sequence: null });
    // And it gets no lock job.
    const keys = (await allJobs(t.db)).map((j) => j.dedupeKey);
    expect(keys).not.toContain(`game_lock:${gameId}:${event.id}`);
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

  describe("the daily identity job", () => {
    const daily = async () =>
      (await allJobs(t.db)).filter((j) => j.kind === "identity_daily");

    /** Queues and runs the day's sync, then lets anything else due run too. */
    async function syncKeeping(at: Date) {
      clock.set(at);
      await enqueueCalendarSync(t.db, clock.now(), 2026);
      await runDue(
        t.db,
        clock,
        { ...pipeline.handlers, identity_daily: async () => {} },
        { maxJobs: 5, leaseMs: 5 * MIN },
      );
    }

    it("sync_calendar queues one identity_daily a day with two running games", async () => {
      // Two games, in 2026 and 2025 (one game per season and type).
      await seedLeagueGames(t.db, T0);
      await t.db.update(games).set({ status: "running" });
      expect(
        await t.db.select().from(games).where(eq(games.status, "running")),
      ).toHaveLength(2);
      await syncKeeping(T0);
      await syncKeeping(new Date(T0.getTime() + 2 * HOUR));
      expect((await daily()).map((j) => j.dedupeKey)).toEqual([
        "identity_daily:2026-02-01",
      ]);
    });

    it("sync_calendar queues one identity_daily a day", async () => {
      await syncKeeping(T0);
      expect(await daily()).toMatchObject([
        {
          dedupeKey: "identity_daily:2026-02-01",
          runAt: T0,
          payload: {},
        },
      ]);
      // A second sync the same day adds none.
      await syncKeeping(new Date(T0.getTime() + 2 * HOUR));
      expect(await daily()).toHaveLength(1);
      // The next day's sync queues the next day's.
      await syncKeeping(new Date(T0.getTime() + DAY));
      expect((await daily()).map((j) => j.dedupeKey).sort()).toEqual([
        "identity_daily:2026-02-01",
        "identity_daily:2026-02-02",
      ]);
    });
  });
});
