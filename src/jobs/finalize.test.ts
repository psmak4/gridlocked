import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { loadBody, rowsOf } from "../../tests/helpers/results-2026";
import {
  eventOfRound,
  jolpicaFixture,
  makePipeline,
  sessionOf,
} from "../../tests/helpers/pipeline-2026";
import {
  events,
  jobs,
  providerIds,
  resultChanges,
  reviewItems,
  sessionResultState,
  sessions,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { openReviewItem } from "@/reference/review";
import { planEventJobs } from "./plan-event";
import { runDue } from "./runner";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("the finalize_check handler", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock: ReturnType<typeof simulatedClock>;
  let pipeline: ReturnType<typeof makePipeline>;

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    clock = simulatedClock(new Date("2026-10-04T00:00:00.000Z"));
    pipeline = makePipeline(t.db, clock);
  });
  afterEach(async () => {
    await t.close();
  });

  const run = async (at: Date) => {
    clock.set(at);
    return runDue(t.db, clock, pipeline.handlers, {
      maxJobs: 20,
      leaseMs: 5 * MIN,
    });
  };
  const after = (d: Date, hours: number) =>
    new Date(d.getTime() + hours * HOUR);

  const RACE = "/ergast/f1/2026/18/results.json";
  const QUALI = "/ergast/f1/2026/18/qualifying.json";

  /**
   * Round 18 planned (without the roster jobs, and without the poll jobs when
   * `polls` is false), entries seeded.
   */
  async function setup({ polls = true }: { polls?: boolean } = {}) {
    const { event } = await eventOfRound(t.db, 18);
    const race = await sessionOf(t.db, event.id, "race");
    const quali = await sessionOf(t.db, event.id, "qualifying");
    await seedEntriesFor(t.db, race.id);
    await planEventJobs(t.db, event.id);
    await t.db.delete(jobs).where(eq(jobs.kind, "roster_check"));
    if (!polls) await t.db.delete(jobs).where(eq(jobs.kind, "poll_session"));
    return { event, race, quali };
  }
  const state = async (sessionId: string) =>
    (
      await t.db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0];
  const eventStatus = async (id: string) =>
    (await t.db.select().from(events).where(eq(events.id, id)))[0]!.status;
  const changes = (sessionId: string) =>
    t.db
      .select()
      .from(resultChanges)
      .where(eq(resultChanges.sessionId, sessionId));

  /** The race body with the first two classified rows swapped. */
  function swapped() {
    const body = loadBody("jolpica/2026/r18-results.json");
    const [a, b] = rowsOf(body, "Results") as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    for (const key of ["position", "positionText"]) {
      [a[key], b[key]] = [b[key], a[key]];
    }
    return body;
  }

  it("runs the whole weekend: polls, a penalty at +2 h, and completion after +48 h", async () => {
    const { event, race, quali } = await setup();
    let raceBody: unknown = jolpicaFixture("r18-results.json");
    pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
    pipeline.serve(RACE, () => raceBody);

    await run(quali.scheduledEnd);
    await run(race.scheduledEnd);
    expect((await state(quali.id))!.status).toBe("provisional");
    expect((await state(race.id))!.status).toBe("provisional");
    const firstSnapshot = (await state(race.id))!.currentSnapshotId;
    expect(await changes(race.id)).toEqual([]);

    // A stewards' decision: two drivers swap places.
    raceBody = swapped();
    await run(after(race.scheduledEnd, 2));
    const logged = await changes(race.id);
    expect(logged.length).toBeGreaterThanOrEqual(2);
    expect(logged.map((c) => c.field)).toContain("position");
    expect((await state(race.id))!.currentSnapshotId).not.toBe(firstSnapshot);
    expect((await state(race.id))!.status).toBe("provisional");
    expect(await eventStatus(event.id)).toBe("scheduled");

    // Nothing more changes at +6 h and +24 h; the race is still re-fetched.
    const loggedCount = logged.length;
    const calls = pipeline.calls.filter((c) => c === RACE).length;
    await run(after(race.scheduledEnd, 6));
    await run(after(race.scheduledEnd, 24));
    expect((await changes(race.id)).length).toBe(loggedCount);
    expect(pipeline.calls.filter((c) => c === RACE).length).toBe(calls + 2);
    expect(await eventStatus(event.id)).toBe("scheduled");
    expect((await state(race.id))!.status).toBe("provisional");

    const done = after(race.scheduledEnd, 48);
    await run(done);
    expect(await eventStatus(event.id)).toBe("completed");
    for (const s of [race, quali]) {
      expect(await state(s.id)).toMatchObject({
        status: "final",
        finalizedAt: done,
      });
    }
    expect(
      await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.eventId, event.id)),
    ).toEqual([]);
  });

  it("an unchanged snapshot writes no changes and does not renormalize", async () => {
    const { race, quali } = await setup();
    pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
    pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
    await run(quali.scheduledEnd);
    await run(race.scheduledEnd);
    const before = await state(race.id);

    await run(after(race.scheduledEnd, 2));
    expect(await state(race.id)).toEqual(before);
    expect(await changes(race.id)).toEqual([]);
  });

  it("re-fetches the sprint as well as the race", async () => {
    const { event } = await eventOfRound(t.db, 2);
    const race = await sessionOf(t.db, event.id, "race");
    await seedEntriesFor(t.db, race.id);
    await planEventJobs(t.db, event.id);
    await t.db.delete(jobs).where(eq(jobs.kind, "poll_session"));
    pipeline.serve(
      "/ergast/f1/2026/2/results.json",
      jolpicaFixture("r02-results.json"),
    );
    pipeline.serve(
      "/ergast/f1/2026/2/sprint.json",
      jolpicaFixture("r02-sprint.json"),
    );

    await run(after(race.scheduledEnd, 2));
    expect(pipeline.calls).toEqual(
      expect.arrayContaining([
        "/ergast/f1/2026/2/results.json",
        "/ergast/f1/2026/2/sprint.json",
      ]),
    );
    // Sprint qualifying and qualifying are not re-fetched.
    expect(pipeline.calls.some((c) => c.endsWith("qualifying.json"))).toBe(
      false,
    );
  });

  describe("the last check", () => {
    it("holds the event when a session has an open blocking item, with a warning", async () => {
      const { event, race, quali } = await setup();
      pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      await openReviewItem(t.db, clock.now(), {
        kind: "validation_failed",
        severity: "blocking",
        seasonId: event.seasonId,
        eventId: event.id,
        sessionId: race.id,
        details: { problem: "steward query" },
        dedupeKey: "test:blocking",
      });

      await run(after(race.scheduledEnd, 48));
      expect(await eventStatus(event.id)).toBe("scheduled");
      expect((await state(race.id))!.status).toBe("under_review");
      expect(await state(quali.id)).toMatchObject({
        status: "provisional",
        finalizedAt: null,
      });
      const [held] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `finalize_held:${event.id}`));
      expect(held).toMatchObject({
        kind: "finalize_held",
        severity: "warning",
        status: "open",
        eventId: event.id,
      });
    });

    it("completes once the blocker is resolved and the check runs again, closing the warning", async () => {
      const { event, race, quali } = await setup();
      pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      await openReviewItem(t.db, clock.now(), {
        kind: "validation_failed",
        severity: "blocking",
        seasonId: event.seasonId,
        eventId: event.id,
        sessionId: race.id,
        details: { problem: "steward query" },
        dedupeKey: "test:blocking",
      });
      const last = after(race.scheduledEnd, 48);
      await run(last);

      await t.db
        .update(reviewItems)
        .set({ status: "resolved", resolution: "checked" })
        .where(eq(reviewItems.dedupeKey, "test:blocking"));
      await t.db
        .update(jobs)
        .set({ status: "pending" })
        .where(eq(jobs.dedupeKey, `finalize:${event.id}:+48h`));
      await run(after(last, 1));

      expect(await eventStatus(event.id)).toBe("completed");
      expect((await state(race.id))!.status).toBe("final");
      expect((await state(quali.id))!.status).toBe("final");
      const [held] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `finalize_held:${event.id}`));
      expect(held!.status).toBe("resolved");
    });

    it("holds the event when a scored session never got results", async () => {
      const { event, race, quali } = await setup();
      // Qualifying was never polled, so it has no results at all.
      await t.db
        .delete(jobs)
        .where(eq(jobs.dedupeKey, `poll:${quali.id}:start`));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(race.scheduledEnd);

      await run(after(race.scheduledEnd, 48));
      expect(await eventStatus(event.id)).toBe("scheduled");
      expect((await state(race.id))!.status).toBe("provisional");
      expect((await state(quali.id))?.status ?? "awaiting").toBe("awaiting");
      const [held] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `finalize_held:${event.id}`));
      expect(held).toMatchObject({ severity: "warning", status: "open" });
    });

    it("ignores a cancelled session when judging the rest", async () => {
      const { event, race, quali } = await setup();
      await t.db
        .update(sessions)
        .set({ status: "cancelled" })
        .where(eq(sessions.id, quali.id));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(race.scheduledEnd);
      await run(after(race.scheduledEnd, 48));
      expect(await eventStatus(event.id)).toBe("completed");
      expect((await state(race.id))!.status).toBe("final");
    });
  });

  describe("a sprint weekend", () => {
    it("finalizes at +48 h with no admin action: sprint qualifying is not scored", async () => {
      const { event, sessions: all } = await eventOfRound(t.db, 2);
      const by = Object.fromEntries(all.map((s) => [s.kind, s]));
      await seedEntriesFor(t.db, by.race!.id);
      await planEventJobs(t.db, event.id);
      pipeline.serve(
        "/ergast/f1/2026/2/qualifying.json",
        jolpicaFixture("r18-qualifying.json"),
      );
      pipeline.serve(
        "/ergast/f1/2026/2/sprint.json",
        jolpicaFixture("r02-sprint.json"),
      );
      pipeline.serve(
        "/ergast/f1/2026/2/results.json",
        jolpicaFixture("r02-results.json"),
      );

      const scored = [by.sprint!, by.qualifying!, by.race!].sort(
        (a, b) => a.scheduledEnd.getTime() - b.scheduledEnd.getTime(),
      );
      for (const s of scored) await run(s.scheduledEnd);
      for (const s of scored) {
        expect((await state(s.id))!.status).toBe("provisional");
      }
      expect(await state(by.sprint_qualifying!.id)).toBeUndefined();

      const done = after(by.race!.scheduledEnd, 48);
      await run(done);
      expect(await eventStatus(event.id)).toBe("completed");
      for (const s of scored) {
        expect(await state(s.id)).toMatchObject({
          status: "final",
          finalizedAt: done,
        });
      }
      expect(
        await t.db
          .select()
          .from(reviewItems)
          .where(eq(reviewItems.eventId, event.id)),
      ).toEqual([]);
    });
  });

  describe("a provider outage", () => {
    it("skips the failed re-fetch and still finalizes on what is stored", async () => {
      const { event, race, quali } = await setup();
      pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
      let down = false;
      pipeline.serve(RACE, () =>
        down
          ? new Response("unavailable", { status: 503 })
          : jolpicaFixture("r18-results.json"),
      );
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      down = true;

      for (const h of [2, 6, 24]) {
        expect(await run(after(race.scheduledEnd, h))).toEqual({
          ran: 1,
          failed: 0,
          lost: 0,
        });
      }
      expect(await eventStatus(event.id)).toBe("scheduled");
      const done = after(race.scheduledEnd, 48);
      expect(await run(done)).toEqual({ ran: 1, failed: 0, lost: 0 });
      expect(await eventStatus(event.id)).toBe("completed");
      expect(await state(race.id)).toMatchObject({
        status: "final",
        finalizedAt: done,
      });
    });

    it("a network failure is skipped the same way", async () => {
      const { race } = await setup({ polls: false });
      pipeline.serve(RACE, () => {
        throw new TypeError("fetch failed");
      });
      expect(await run(after(race.scheduledEnd, 2))).toEqual({
        ran: 1,
        failed: 0,
        lost: 0,
      });
    });
  });

  describe("skipping", () => {
    it("does nothing for a cancelled event", async () => {
      const { event, race } = await setup({ polls: false });
      await t.db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, event.id));
      await run(after(race.scheduledEnd, 48));
      expect(pipeline.calls).toEqual([]);
      expect(await eventStatus(event.id)).toBe("cancelled");
    });

    it("does nothing for a completed event", async () => {
      const { event, race } = await setup({ polls: false });
      await t.db
        .update(events)
        .set({ status: "completed" })
        .where(eq(events.id, event.id));
      await run(after(race.scheduledEnd, 2));
      expect(pipeline.calls).toEqual([]);
    });

    it("leaves a session that is already final alone", async () => {
      const { race, quali } = await setup();
      pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      await t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: clock.now() })
        .where(eq(sessionResultState.sessionId, race.id));
      const before = await state(race.id);
      pipeline.serve(RACE, swapped());
      pipeline.calls.length = 0;

      await run(after(race.scheduledEnd, 2));
      expect(await state(race.id)).toEqual(before);
      expect(await changes(race.id)).toEqual([]);
      expect(pipeline.calls).not.toContain(RACE);
    });

    it("still fails for the runner's retry on a programming error", async () => {
      const { race } = await setup({ polls: false });
      await t.db.delete(providerIds);
      const res = await run(after(race.scheduledEnd, 2));
      expect(res).toEqual({ ran: 0, failed: 1, lost: 0 });
    });
  });
});
