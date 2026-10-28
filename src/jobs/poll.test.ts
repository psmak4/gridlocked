import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { loadBody, rowsOf } from "../../tests/helpers/results-2026";
import {
  allJobs,
  eventOfRound,
  jolpicaFixture,
  makePipeline,
  sessionOf,
} from "../../tests/helpers/pipeline-2026";
import {
  eventEntries,
  events,
  jobs,
  results,
  reviewItems,
  sessionResultState,
  sessions,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { enqueue } from "./queue";
import { runDue } from "./runner";
import { pollAttemptKey, pollStartKey } from "./kinds";

const MIN = 60_000;
const HOUR = 60 * MIN;
const EMPTY = "r23-results-empty.json";

describe("the poll_session handler", () => {
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
      maxJobs: 10,
      leaseMs: 5 * MIN,
    });
  };

  /** A session with its entries and the planned start poll enqueued. */
  async function startPoll(round: number, kind: string, serveFile?: string) {
    const { event } = await eventOfRound(t.db, round);
    const session = await sessionOf(t.db, event.id, kind);
    await seedEntriesFor(t.db, session.id);
    await enqueue(t.db, {
      kind: "poll_session",
      dedupeKey: pollStartKey(session.id),
      runAt: session.scheduledEnd,
      payload: { sessionId: session.id, attempt: 0 },
    });
    if (serveFile) {
      const path = {
        race: "results",
        qualifying: "qualifying",
        sprint: "sprint",
      }[kind as "race"];
      pipeline.serve(
        `/ergast/f1/2026/${round}/${path}.json`,
        jolpicaFixture(serveFile),
      );
    }
    return session;
  }

  const state = async (sessionId: string) =>
    (
      await t.db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0];
  const pollJobs = async () =>
    (await allJobs(t.db)).filter((j) => j.kind === "poll_session");
  const items = (sessionId: string) =>
    t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.sessionId, sessionId))
      .orderBy(asc(reviewItems.dedupeKey));

  it("fetches, normalizes and advances: published results become provisional and polling stops", async () => {
    const race = await startPoll(18, "race", "r18-results.json");
    expect(await run(race.scheduledEnd)).toEqual({
      ran: 1,
      failed: 0,
      lost: 0,
    });

    expect(pipeline.calls).toEqual(["/ergast/f1/2026/18/results.json"]);
    expect(await state(race.id)).toMatchObject({
      status: "provisional",
      pollAttempts: 1,
      nextPollAt: null,
      gaveUpAt: null,
    });
    const rows = await t.db
      .select()
      .from(results)
      .where(eq(results.sessionId, race.id));
    expect(rows).toHaveLength(22);
    const jobsNow = await pollJobs();
    expect(jobsNow.map((j) => [j.dedupeKey, j.status])).toEqual([
      [pollStartKey(race.id), "succeeded"],
    ]);
  });

  it("asks Jolpica for qualifying and sprint results by the event's season and round", async () => {
    const quali = await startPoll(18, "qualifying", "r18-qualifying.json");
    await run(quali.scheduledEnd);
    expect((await state(quali.id))!.status).toBe("provisional");

    const sprint = await startPoll(2, "sprint", "r02-sprint.json");
    await run(sprint.scheduledEnd);
    expect(pipeline.calls).toEqual([
      "/ergast/f1/2026/18/qualifying.json",
      "/ergast/f1/2026/2/sprint.json",
    ]);
    expect((await state(sprint.id))!.currentSnapshotId).not.toBeNull();
  });

  it("while awaiting, re-enqueues at +5, +15, then +60 minutes", async () => {
    const race = await startPoll(18, "race", EMPTY);
    const end = race.scheduledEnd.getTime();

    const offsets: number[] = [];
    let at = race.scheduledEnd;
    for (let i = 0; i < 4; i++) {
      expect(await run(at)).toMatchObject({ ran: 1, failed: 0 });
      const pending = (await pollJobs()).filter((j) => j.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.dedupeKey).toBe(pollAttemptKey(race.id, i + 1));
      expect(pending[0]!.payload).toEqual({
        sessionId: race.id,
        attempt: i + 1,
      });
      offsets.push((pending[0]!.runAt.getTime() - end) / MIN);
      at = pending[0]!.runAt;
    }
    // +5, +15, +60, +60 after each attempt.
    expect(offsets).toEqual([5, 20, 80, 140]);
    expect(await state(race.id)).toMatchObject({
      status: "awaiting",
      pollAttempts: 4,
      gaveUpAt: null,
    });
    expect((await state(race.id))!.nextPollAt!.getTime() - end).toBe(140 * MIN);
  });

  it("stops re-enqueueing once the results appear", async () => {
    const race = await startPoll(18, "race");
    let published = false;
    pipeline.serve("/ergast/f1/2026/18/results.json", () =>
      published ? jolpicaFixture("r18-results.json") : jolpicaFixture(EMPTY),
    );
    await run(race.scheduledEnd);
    await run(new Date(race.scheduledEnd.getTime() + 5 * MIN));
    expect((await state(race.id))!.status).toBe("awaiting");

    published = true;
    await run(new Date(race.scheduledEnd.getTime() + 20 * MIN));
    expect((await state(race.id))!.status).toBe("provisional");
    expect((await pollJobs()).filter((j) => j.status === "pending")).toEqual(
      [],
    );
    expect((await state(race.id))!.nextPollAt).toBeNull();
  });

  describe("giving up", () => {
    const gaveUp = (sessionId: string) =>
      items(sessionId).then((rows) =>
        rows.filter((i) => i.kind === "poll_gave_up"),
      );

    it("gives up once 24 hours have passed: gave_up_at, a blocking item, and the session held", async () => {
      const race = await startPoll(18, "race", EMPTY);
      let at = race.scheduledEnd;
      let runs = 0;
      for (;;) {
        await run(at);
        runs++;
        const pending = (await pollJobs()).filter(
          (j) => j.status === "pending",
        );
        if (pending.length === 0) break;
        expect(runs).toBeLessThan(40);
        at = pending[0]!.runAt;
      }

      // 5, 20, 80 minutes, then hourly: the first attempt at or past 24 h.
      const gaveUpAt = new Date(race.scheduledEnd.getTime() + 1460 * MIN);
      expect(clock.now()).toEqual(gaveUpAt);
      const s = (await state(race.id))!;
      expect(s.gaveUpAt).toEqual(gaveUpAt);
      expect(s.nextPollAt).toBeNull();
      expect(s.pollAttempts).toBe(runs);
      expect(s.status).toBe("under_review");

      const [item] = await gaveUp(race.id);
      expect(item).toMatchObject({
        kind: "poll_gave_up",
        severity: "blocking",
        status: "open",
        dedupeKey: `poll_gave_up:${race.id}`,
        sessionId: race.id,
        eventId: race.eventId,
      });
    });

    it("gives up exactly at scheduled end + 24 h, not a moment before", async () => {
      const race = await startPoll(18, "race", EMPTY);
      await t.db.delete(jobs);
      const attempt = (n: number, runAt: Date) =>
        enqueue(t.db, {
          kind: "poll_session",
          dedupeKey: pollAttemptKey(race.id, n),
          runAt,
          payload: { sessionId: race.id, attempt: n },
        });
      const edge = new Date(race.scheduledEnd.getTime() + 24 * HOUR);

      await attempt(7, new Date(edge.getTime() - 1));
      await run(new Date(edge.getTime() - 1));
      expect((await state(race.id))!.gaveUpAt).toBeNull();
      expect(await gaveUp(race.id)).toEqual([]);

      await attempt(8, edge);
      await run(edge);
      expect((await state(race.id))!.gaveUpAt).toEqual(edge);
      expect(await gaveUp(race.id)).toHaveLength(1);
    });

    it("an empty session is missing every entered driver: one blocking missing_driver item each", async () => {
      const race = await startPoll(18, "race", EMPTY);
      await run(new Date(race.scheduledEnd.getTime() + 24 * HOUR));
      // The start job ran 24 h late: it is past the window at once.
      const entries = await t.db
        .select()
        .from(eventEntries)
        .where(eq(eventEntries.eventId, race.eventId));
      const missing = (await items(race.id)).filter(
        (i) => i.kind === "missing_driver",
      );

      expect(entries).toHaveLength(22);
      expect(missing).toHaveLength(22);
      expect(new Set(missing.map((i) => i.driverId))).toEqual(
        new Set(entries.map((e) => e.driverId)),
      );
      expect(missing.every((i) => i.severity === "blocking")).toBe(true);
      expect(missing[0]!.dedupeKey).toBe(
        `poll_gave_up:${race.id}:missing:${missing[0]!.driverId}`,
      );
      expect((await state(race.id))!.status).toBe("under_review");
    });

    it("a partly published session is missing only the drivers with no row", async () => {
      const race = await startPoll(18, "race");
      const body = loadBody("jolpica/2026/r18-results.json");
      const rows = rowsOf(body, "Results");
      const dropped = rows
        .splice(20, 2)
        .map((r) => (r.Driver as { driverId: string }).driverId);
      pipeline.serve("/ergast/f1/2026/18/results.json", body);

      await run(new Date(race.scheduledEnd.getTime() + 24 * HOUR));
      const missing = (await items(race.id)).filter(
        (i) => i.kind === "missing_driver",
      );
      expect(missing).toHaveLength(2);
      expect((await state(race.id))!.gaveUpAt?.getTime()).toBe(
        race.scheduledEnd.getTime() + 24 * HOUR,
      );
      expect(dropped).toHaveLength(2);
      expect(await gaveUp(race.id)).toHaveLength(1);
    });

    it("does not give up a session that has results", async () => {
      const race = await startPoll(18, "race", "r18-results.json");
      await run(new Date(race.scheduledEnd.getTime() + 30 * HOUR));
      expect((await state(race.id))!.gaveUpAt).toBeNull();
      expect(await items(race.id)).toEqual([]);
    });
  });

  describe("skipping and failing", () => {
    it("does nothing for a cancelled session", async () => {
      const race = await startPoll(18, "race", "r18-results.json");
      await t.db
        .update(sessions)
        .set({ status: "cancelled" })
        .where(eq(sessions.id, race.id));
      expect(await run(race.scheduledEnd)).toMatchObject({ ran: 1 });
      expect(pipeline.calls).toEqual([]);
      expect(await state(race.id)).toBeUndefined();
    });

    it("does nothing for a session of a cancelled event", async () => {
      const race = await startPoll(18, "race", "r18-results.json");
      await t.db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, race.eventId));
      expect(await run(race.scheduledEnd)).toMatchObject({ ran: 1 });
      expect(pipeline.calls).toEqual([]);
    });

    it("does not touch a final session", async () => {
      const race = await startPoll(18, "race", "r18-results.json");
      await run(race.scheduledEnd);
      await t.db
        .update(sessionResultState)
        .set({ status: "final" })
        .where(eq(sessionResultState.sessionId, race.id));
      pipeline.calls.length = 0;
      await enqueue(t.db, {
        kind: "poll_session",
        dedupeKey: pollAttemptKey(race.id, 1),
        runAt: race.scheduledEnd,
        payload: { sessionId: race.id, attempt: 1 },
      });
      await run(race.scheduledEnd);
      expect(pipeline.calls).toEqual([]);
      expect((await state(race.id))!.status).toBe("final");
    });

    it("a provider error fails the job for the runner's retry and changes nothing", async () => {
      const race = await startPoll(18, "race"); // nothing served: 404
      expect(await run(race.scheduledEnd)).toEqual({
        ran: 0,
        failed: 1,
        lost: 0,
      });
      const [job] = await pollJobs();
      expect(job).toMatchObject({ status: "failed", attempts: 1 });
      expect(job!.lastError).toMatch(/404/);
      expect(await state(race.id)).toBeUndefined();
    });

    it("fails a payload it cannot read", async () => {
      await enqueue(t.db, {
        kind: "poll_session",
        dedupeKey: "poll:bad:start",
        runAt: clock.now(),
        payload: { sessionId: 7 },
      });
      expect(await run(clock.now())).toMatchObject({ ran: 0, failed: 1 });
    });

    it("fails for a session kind Jolpica has no results for", async () => {
      const { event } = await eventOfRound(t.db, 2);
      const sq = await sessionOf(t.db, event.id, "sprint_qualifying");
      await enqueue(t.db, {
        kind: "poll_session",
        dedupeKey: pollStartKey(sq.id),
        runAt: clock.now(),
        payload: { sessionId: sq.id, attempt: 0 },
      });
      await run(clock.now());
      const [job] = await pollJobs();
      expect(job!.status).toBe("failed");
      expect(job!.lastError).toMatch(/sprint_qualifying/);
    });
  });

  it("is safe to run twice for the same attempt", async () => {
    const race = await startPoll(18, "race", EMPTY);
    await run(race.scheduledEnd);
    const [start] = await pollJobs();
    const ctx = { db: t.db, clock };
    await pipeline.handlers.poll_session!(start!, ctx);

    const next = (await pollJobs()).filter((j) => j.status === "pending");
    expect(next.map((j) => j.dedupeKey)).toEqual([pollAttemptKey(race.id, 1)]);
    expect(await state(race.id)).toMatchObject({
      pollAttempts: 1,
      status: "awaiting",
    });
    expect(
      await t.db
        .select()
        .from(reviewItems)
        .where(and(eq(reviewItems.sessionId, race.id))),
    ).toEqual([]);
  });
});
