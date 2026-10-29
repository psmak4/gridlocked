import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { readFixture } from "../../tests/helpers/fixtures";
import {
  eventOfRound,
  makePipeline,
  openF1KeyFor,
  sessionOf,
} from "../../tests/helpers/pipeline-2026";
import {
  drivers,
  eventEntries,
  events,
  jobs,
  providerIds,
  reviewItems,
  sessionParticipants,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { enqueue } from "./queue";
import { rosterKey } from "./kinds";
import { runDue } from "./runner";

const MIN = 60_000;

describe("the roster_check handler", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock: ReturnType<typeof simulatedClock>;
  let pipeline: ReturnType<typeof makePipeline>;

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    clock = simulatedClock(new Date("2026-07-24T00:00:00.000Z"));
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

  /** Round 13's FP2 with its entries, OpenF1 serving the recorded answers. */
  async function setup() {
    const { event } = await eventOfRound(t.db, 13);
    const fp2 = await sessionOf(t.db, event.id, "fp2");
    await seedEntriesFor(t.db, fp2.id);
    const key = await openF1KeyFor(t.db, fp2.id);
    pipeline.serve("/v1/sessions", readFixture("openf1/2026/sessions.json"));
    pipeline.serve(
      `/v1/drivers#${key}`,
      readFixture("openf1/2026/drivers-r13-fp2.json"),
    );
    const job = () =>
      enqueue(t.db, {
        kind: "roster_check",
        dedupeKey: rosterKey(event.id, "fp2"),
        runAt: new Date(fp2.scheduledEnd.getTime() + 30 * MIN),
        payload: { eventId: event.id, sessionId: fp2.id },
      });
    await job();
    return {
      event,
      fp2,
      key,
      due: new Date(fp2.scheduledEnd.getTime() + 30 * MIN),
    };
  }

  const participants = (sessionId: string) =>
    t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, sessionId));

  it("links the OpenF1 session, stores the participants and finds nothing wrong", async () => {
    const { event, fp2, key, due } = await setup();
    expect(await run(due)).toEqual({ ran: 1, failed: 0, lost: 0 });

    expect(pipeline.calls).toEqual(["/v1/sessions", `/v1/drivers#${key}`]);
    const [link] = await t.db
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, "openf1"),
          eq(providerIds.entityType, "session"),
          eq(providerIds.entityId, fp2.id),
        ),
      );
    expect(link!.providerKey).toBe(String(key));
    expect(await participants(fp2.id)).toHaveLength(22);
    expect(
      await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.eventId, event.id)),
    ).toEqual([]);
  });

  it("does not look the session up again once it is linked", async () => {
    const { event, fp2, key, due } = await setup();
    await run(due);
    pipeline.calls.length = 0;
    await t.db.delete(jobs);
    await enqueue(t.db, {
      kind: "roster_check",
      dedupeKey: rosterKey(event.id, "fp2"),
      runAt: due,
      payload: { eventId: event.id, sessionId: fp2.id },
    });
    await run(due);
    expect(pipeline.calls).toEqual([`/v1/drivers#${key}`]);
  });

  it("warns about an entered driver who did not run", async () => {
    const { event, fp2, due } = await setup();
    const [entry] = await t.db
      .select()
      .from(eventEntries)
      .where(eq(eventEntries.eventId, event.id));
    // An entry for a driver who is not in the practice session.
    await t.db
      .update(eventEntries)
      .set({ driverId: await spareDriver(entry!.driverId) })
      .where(
        and(
          eq(eventEntries.eventId, event.id),
          eq(eventEntries.driverId, entry!.driverId),
        ),
      );
    await run(due);

    const warnings = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.eventId, event.id));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.severity === "warning")).toBe(true);
    expect(await participants(fp2.id)).toHaveLength(22);
  });

  describe("OpenF1 has no matching session yet", () => {
    const retries = async () =>
      (await t.db.select().from(jobs).orderBy(jobs.runAt)).filter((j) =>
        j.dedupeKey.includes(":retry:"),
      );
    const warnings = () =>
      t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.kind, "roster_unavailable"));

    it("is like an outage: the job succeeds and the check comes again later, with backoff", async () => {
      const { event, due } = await setup();
      pipeline.serve("/v1/sessions", []);

      expect(await run(due)).toEqual({ ran: 1, failed: 0, lost: 0 });
      let next = await retries();
      expect(next.map((j) => [j.dedupeKey, j.status, j.runAt])).toEqual([
        [
          `roster:${event.id}:fp2:retry:1`,
          "pending",
          new Date(due.getTime() + 5 * MIN),
        ],
      ]);
      expect(next[0]!.payload).toMatchObject({ attempt: 1 });

      // Still nothing: the next gap is longer (the poll schedule: 5, 15, 60).
      const second = new Date(due.getTime() + 5 * MIN);
      expect(await run(second)).toEqual({ ran: 1, failed: 0, lost: 0 });
      next = await retries();
      expect(next.map((j) => [j.dedupeKey, j.runAt])).toEqual([
        [`roster:${event.id}:fp2:retry:1`, second],
        [
          `roster:${event.id}:fp2:retry:2`,
          new Date(second.getTime() + 15 * MIN),
        ],
      ]);
      expect(await warnings()).toEqual([]);
    });

    it("finishes the check when the session appears", async () => {
      const { event, fp2, key, due } = await setup();
      let served = false;
      pipeline.serve("/v1/sessions", () =>
        served ? readFixture("openf1/2026/sessions.json") : [],
      );
      await run(due);
      served = true;
      const retry = new Date(due.getTime() + 5 * MIN);
      expect(await run(retry)).toEqual({ ran: 1, failed: 0, lost: 0 });

      expect(pipeline.calls).toContain(`/v1/drivers#${key}`);
      expect(await participants(fp2.id)).toHaveLength(22);
      // No third attempt, and nothing to report.
      expect((await retries()).map((j) => j.dedupeKey)).toEqual([
        `roster:${event.id}:fp2:retry:1`,
      ]);
      expect(await warnings()).toEqual([]);
    });

    it("keeps trying until six hours after the session ends, then opens a warning", async () => {
      const { event, fp2, due } = await setup();
      pipeline.serve("/v1/sessions", []);
      const deadline = new Date(fp2.scheduledEnd.getTime() + 6 * 60 * MIN);

      let at = due;
      let runs = 0;
      for (; runs < 50; runs++) {
        expect(await run(at)).toEqual({ ran: 1, failed: 0, lost: 0 });
        const pending = (await retries()).filter((j) => j.status === "pending");
        if (pending.length === 0) break;
        expect(pending[0]!.runAt.getTime()).toBeLessThanOrEqual(
          deadline.getTime(),
        );
        at = pending[0]!.runAt;
      }

      // The last attempt is at the deadline itself.
      expect(at).toEqual(deadline);
      expect(runs).toBeGreaterThan(3);
      const [warning] = await warnings();
      expect(warning).toMatchObject({
        kind: "roster_unavailable",
        severity: "warning",
        status: "open",
        eventId: event.id,
        sessionId: fp2.id,
        dedupeKey: `roster_unavailable:${fp2.id}`,
      });
      expect(warning!.details).toMatchObject({ kind: "fp2" });
      // Nothing dead, nothing failed: it was handled.
      expect(
        (await t.db.select().from(jobs)).every((j) => j.status === "succeeded"),
      ).toBe(true);
      expect(
        await t.db
          .select()
          .from(reviewItems)
          .where(eq(reviewItems.kind, "job_dead")),
      ).toEqual([]);
    });

    it("treats an OpenF1 outage the same way", async () => {
      const { event, due } = await setup();
      pipeline.serve(
        "/v1/sessions",
        () => new Response("down", { status: 503 }),
      );
      expect(await run(due)).toEqual({ ran: 1, failed: 0, lost: 0 });
      expect((await retries()).map((j) => j.dedupeKey)).toEqual([
        `roster:${event.id}:fp2:retry:1`,
      ]);
    });

    it("still fails the job on a programming error", async () => {
      const { due } = await setup();
      // A 404 means we asked wrongly, not that OpenF1 is down.
      pipeline.serve("/v1/sessions", () => new Response("no", { status: 404 }));
      expect(await run(due)).toEqual({ ran: 0, failed: 1, lost: 0 });
    });
  });

  it("does nothing for a cancelled event", async () => {
    const { event, due } = await setup();
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, event.id));
    expect(await run(due)).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(pipeline.calls).toEqual([]);
  });

  async function spareDriver(not: string): Promise<string> {
    // Any driver of the season who is neither the one replaced nor entered.
    const entered = new Set(
      (await t.db.select().from(eventEntries)).map((e) => e.driverId),
    );
    const all = await t.db.select({ id: drivers.id }).from(drivers);
    const spare = all.find((d) => d.id !== not && !entered.has(d.id));
    if (!spare) throw new Error("no spare driver in the fixtures");
    return spare.id;
  }
});
