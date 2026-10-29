import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
import { enqueue } from "./queue";
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

  /**
   * Round 18's recorded qualifying relabelled as round 2's (the recordings
   * have no round 2 qualifying), so it passes the check that a body is for
   * the event asked.
   */
  function round2Qualifying() {
    const body = loadBody("jolpica/2026/r18-qualifying.json");
    Object.assign(body.MRData.RaceTable.Races[0]!, {
      round: "2",
      date: "2026-03-15",
    });
    return body;
  }

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
  /** The follow-up checks of a held event, in order. */
  const heldJobs = async (eventId: string) =>
    (await allJobs(t.db)).filter((j) =>
      j.dedupeKey.startsWith(`finalize:${eventId}:held:`),
    );
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
    pipeline.serve("/ergast/f1/2026/2/qualifying.json", round2Qualifying());

    await run(after(race.scheduledEnd, 2));
    expect(pipeline.calls).toEqual(
      expect.arrayContaining([
        "/ergast/f1/2026/2/results.json",
        "/ergast/f1/2026/2/sprint.json",
      ]),
    );
    // Qualifying is re-fetched too (a post-session disqualification); sprint
    // qualifying has no Jolpica endpoint.
    expect(pipeline.calls).toContain("/ergast/f1/2026/2/qualifying.json");
    expect(pipeline.calls.some((c) => c.includes("sprint_qualifying"))).toBe(
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

    it("keeps re-checking a held event every 6 h: once the blocker is resolved the next check finalizes", async () => {
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

      const [held1] = await heldJobs(event.id);
      expect(held1).toMatchObject({
        dedupeKey: `finalize:${event.id}:held:1`,
        status: "pending",
        runAt: after(race.scheduledEnd, 54),
      });
      expect(held1!.payload).toMatchObject({ final: true, held: 1 });

      // Still blocked at the next check: held again, a further 6 h on.
      await run(after(race.scheduledEnd, 54));
      expect(await eventStatus(event.id)).toBe("scheduled");
      expect((await heldJobs(event.id)).map((j) => j.dedupeKey)).toEqual([
        `finalize:${event.id}:held:1`,
        `finalize:${event.id}:held:2`,
      ]);

      // An admin resolves the blocker; the following check finalizes.
      await t.db
        .update(reviewItems)
        .set({ status: "resolved", resolution: "checked" })
        .where(eq(reviewItems.dedupeKey, "test:blocking"));
      const done = after(race.scheduledEnd, 60);
      await run(done);
      expect(await eventStatus(event.id)).toBe("completed");
      for (const s of [race, quali]) {
        expect(await state(s.id)).toMatchObject({
          status: "final",
          finalizedAt: done,
        });
      }
      // Finalized: no further check was queued.
      expect((await heldJobs(event.id)).map((j) => j.dedupeKey)).toEqual([
        `finalize:${event.id}:held:1`,
        `finalize:${event.id}:held:2`,
      ]);
      const [warning] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `finalize_held:${event.id}`));
      expect(warning!.status).toBe("resolved");
    });

    it("a hold that never clears stops re-checking 14 days after the race, with the warning left open", async () => {
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
        details: { problem: "never resolved" },
        dedupeKey: "test:blocking",
      });

      let at = after(race.scheduledEnd, 48);
      for (let i = 0; i < 100; i++) {
        await run(at);
        const pending = (await heldJobs(event.id)).filter(
          (j) => j.status === "pending",
        );
        if (pending.length === 0) break;
        at = pending[0]!.runAt;
      }

      // 48 h, then every 6 h: the check at exactly 14 days is the last.
      expect(clock.now()).toEqual(after(race.scheduledEnd, 14 * 24));
      const held = await heldJobs(event.id);
      expect(held).toHaveLength(48);
      expect(held.every((j) => j.status === "succeeded")).toBe(true);
      expect(await eventStatus(event.id)).toBe("scheduled");
      const [warning] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `finalize_held:${event.id}`));
      expect(warning).toMatchObject({ status: "open" });
      expect(warning!.details).toMatchObject({ recheckStopped: true });
    });

    it("holds the event when a scored session never got results", async () => {
      const { event, race, quali } = await setup();
      // Qualifying was never polled, so it has no results at all.
      await t.db
        .delete(jobs)
        .where(eq(jobs.dedupeKey, `poll:${quali.id}:start`));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      // Jolpica has nothing for qualifying: its "no results yet" answer.
      pipeline.serve(QUALI, jolpicaFixture("r23-results-empty.json"));
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

  describe("qualifying", () => {
    const block = (
      event: { id: string; seasonId: string },
      sessionId: string,
    ) =>
      openReviewItem(t.db, clock.now(), {
        kind: "validation_failed",
        severity: "blocking",
        seasonId: event.seasonId,
        eventId: event.id,
        sessionId,
        details: { problem: "steward query" },
        dedupeKey: "test:quali-blocking",
      });

    it("held by a blocking item and then resolved by an admin, the next check clears it and finalizes the event", async () => {
      const { event, race, quali } = await setup();
      pipeline.serve(QUALI, jolpicaFixture("r18-qualifying.json"));
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      // A steward query is open when qualifying is polled, so it goes
      // under review at once.
      await block(event, quali.id);
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      expect((await state(quali.id))!.status).toBe("under_review");

      // The +48 h check holds the event.
      await run(after(race.scheduledEnd, 48));
      expect((await state(quali.id))!.status).toBe("under_review");
      expect(await eventStatus(event.id)).toBe("scheduled");

      // An admin resolves the item and does nothing else (the status stays
      // under_review until something advances it).
      await t.db
        .update(reviewItems)
        .set({ status: "resolved", resolution: "checked" })
        .where(eq(reviewItems.dedupeKey, "test:quali-blocking"));
      expect((await state(quali.id))!.status).toBe("under_review");

      const done = after(race.scheduledEnd, 54);
      await run(done);
      expect(await state(quali.id)).toMatchObject({
        status: "final",
        finalizedAt: done,
      });
      expect(await eventStatus(event.id)).toBe("completed");
    });

    it("a post-session disqualification in a changed snapshot is picked up by a finalize check", async () => {
      const { event, race, quali } = await setup();
      let qualiBody: unknown = jolpicaFixture("r18-qualifying.json");
      pipeline.serve(QUALI, () => qualiBody);
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      const first = (await state(quali.id))!.currentSnapshotId;
      expect(await changes(quali.id)).toEqual([]);

      // The stewards disqualify the pole sitter: he drops to the back.
      const body = loadBody("jolpica/2026/r18-qualifying.json");
      const rows = rowsOf(body, "QualifyingResults");
      const [pole] = rows.splice(0, 1);
      rows.forEach((r, i) => (r.position = String(i + 1)));
      pole!.position = String(rows.length + 1);
      rows.push(pole!);
      qualiBody = body;

      await run(after(race.scheduledEnd, 2));
      expect((await state(quali.id))!.currentSnapshotId).not.toBe(first);
      const logged = await changes(quali.id);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.map((c) => c.field)).toContain("position");
      expect((await state(quali.id))!.status).toBe("provisional");
      expect(await eventStatus(event.id)).toBe("scheduled");
    });

    it("a disqualified driver missing from a changed snapshot holds the event for an admin", async () => {
      const { event, race, quali } = await setup();
      let qualiBody: unknown = jolpicaFixture("r18-qualifying.json");
      pipeline.serve(QUALI, () => qualiBody);
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);

      const body = loadBody("jolpica/2026/r18-qualifying.json");
      rowsOf(body, "QualifyingResults").splice(0, 1);
      qualiBody = body;
      await run(after(race.scheduledEnd, 2));
      expect((await state(quali.id))!.status).toBe("under_review");

      await run(after(race.scheduledEnd, 48));
      expect(await eventStatus(event.id)).toBe("scheduled");
      expect((await state(quali.id))!.status).toBe("under_review");
    });

    it("moves an admin-resolved session on even when the provider is down at that check", async () => {
      const { event, race, quali } = await setup();
      let down = false;
      pipeline.serve(QUALI, () =>
        down
          ? new Response("unavailable", { status: 503 })
          : jolpicaFixture("r18-qualifying.json"),
      );
      pipeline.serve(RACE, jolpicaFixture("r18-results.json"));
      await run(quali.scheduledEnd);
      await run(race.scheduledEnd);
      await block(event, quali.id);
      await run(after(race.scheduledEnd, 2));
      expect((await state(quali.id))!.status).toBe("under_review");

      down = true;
      await t.db
        .update(reviewItems)
        .set({ status: "resolved", resolution: "checked" })
        .where(eq(reviewItems.dedupeKey, "test:quali-blocking"));
      await run(after(race.scheduledEnd, 6));
      expect((await state(quali.id))!.status).toBe("provisional");
    });
  });

  describe("a sprint weekend", () => {
    it("finalizes at +48 h with no admin action: sprint qualifying is not scored", async () => {
      const { event, sessions: all } = await eventOfRound(t.db, 2);
      const by = Object.fromEntries(all.map((s) => [s.kind, s]));
      await seedEntriesFor(t.db, by.race!.id);
      await planEventJobs(t.db, event.id);
      pipeline.serve("/ergast/f1/2026/2/qualifying.json", round2Qualifying());
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
    it("skips a failed re-fetch at the early checks, but does not finalize on stored data at the last one", async () => {
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
      expect(await run(after(race.scheduledEnd, 48))).toEqual({
        ran: 1,
        failed: 0,
        lost: 0,
      });
      // Held for a late correction: the next check is an hour away.
      expect(await eventStatus(event.id)).toBe("scheduled");
      expect((await state(race.id))!.status).toBe("provisional");
      const next = await heldJobs(event.id);
      expect(next.map((j) => [j.dedupeKey, j.status, j.runAt])).toEqual([
        [
          `finalize:${event.id}:held:1`,
          "pending",
          after(race.scheduledEnd, 49),
        ],
      ]);
      expect(next[0]!.payload).toMatchObject({ final: true, held: 1 });

      // The provider is back: the next held check re-fetches and finalizes.
      down = false;
      const done = after(race.scheduledEnd, 49);
      await run(done);
      expect(await eventStatus(event.id)).toBe("completed");
      expect(await state(race.id)).toMatchObject({
        status: "final",
        finalizedAt: done,
      });
    });

    it("a provider that stays down past 14 days stops the re-checks and says so in the warning", async () => {
      const { event, race } = await setup({ polls: false });
      pipeline.serve(RACE, () => new Response("down", { status: 503 }));
      pipeline.serve(QUALI, () => new Response("down", { status: 503 }));
      const last = after(race.scheduledEnd, 14 * 24);
      await enqueue(t.db, {
        kind: "finalize_check",
        dedupeKey: `finalize:${event.id}:held:99`,
        runAt: last,
        payload: { eventId: event.id, afterHours: 48, final: true, held: 99 },
      });
      await run(last);

      expect((await heldJobs(event.id)).map((j) => j.dedupeKey)).toEqual([
        `finalize:${event.id}:held:99`,
      ]);
      const [warning] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `finalize_held:${event.id}`));
      expect(warning).toMatchObject({ status: "open", severity: "warning" });
      expect(warning!.details).toMatchObject({
        providerUnavailable: true,
        recheckStopped: true,
      });
    });

    it("a network failure is skipped the same way", async () => {
      const { race } = await setup({ polls: false });
      for (const path of [QUALI, RACE]) {
        pipeline.serve(path, () => {
          throw new TypeError("fetch failed");
        });
      }
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

    it("fails for the runner's retry when the provider answers 404", async () => {
      const { race } = await setup({ polls: false });
      // Nothing served: a 404 is a bug in the request, not an outage.
      const res = await run(after(race.scheduledEnd, 2));
      expect(res).toEqual({ ran: 0, failed: 1, lost: 0 });
    });

    it("still fails for the runner's retry on a programming error", async () => {
      const { race } = await setup({ polls: false });
      await t.db.delete(providerIds);
      const res = await run(after(race.scheduledEnd, 2));
      expect(res).toEqual({ ran: 0, failed: 1, lost: 0 });
    });
  });
});
