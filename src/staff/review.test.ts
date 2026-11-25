import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { eventOfRound } from "../../tests/helpers/pipeline-2026";
import {
  idFor,
  ingest,
  ingestRecorded,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import {
  loadBody,
  rowsOf,
  sessionIdFor,
} from "../../tests/helpers/results-2026";
import {
  auditLog,
  driverAvailability,
  events,
  jobs,
  reviewItems,
  seatAssignments,
  sessionResultState,
} from "@/db/schema";
import { DUE_KEY } from "@/jobs/due-times";
import { enqueue } from "@/jobs/queue";
import { openReviewItem } from "@/reference/review";
import { advanceStatus } from "@/results/status";
import { getSessionContext } from "@/results/session-context";
import { StaffError } from "./errors";
import type { StaffActor } from "./roster";
import { resolveReviewItem, reviewItem, reviewList } from "./review";

// The review queue (M8 Task 10) over the 2026 world with seats: round 18's
// race with a team change nobody recorded, a driver missing, and an event the
// provider dropped. An action and the resolve are one transaction.
const T0 = new Date("2026-10-04T08:00:00.000Z");
const T1 = new Date("2026-10-04T09:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: null, requestId: "r1" };

describe("the review queue (M8 Task 10)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  const item = async (id: string) =>
    (await t.db.select().from(reviewItems).where(eq(reviewItems.id, id)))[0]!;
  const reviewAudits = () =>
    t.db.select().from(auditLog).where(like(auditLog.action, "review_item.%"));
  const statusOf = async (sessionId: string) =>
    (
      await t.db
        .select({ status: sessionResultState.status })
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0]?.status;

  /** Round 18's race with Russell's row driven for `constructorKey`. */
  async function raceWithRussellIn(constructorKey: string) {
    const id = await sessionIdFor(t.db, 18, "race");
    await seedEntriesFor(t.db, id);
    const body = loadBody("jolpica/2026/r18-results.json");
    const row = rowsOf(body, "Results").find(
      (r) => (r.Driver as { driverId: string }).driverId === "russell",
    )!;
    (row.Constructor as { constructorId: string }).constructorId =
      constructorKey;
    await ingest(t.db, T0, id, "race", body);
    await advanceStatus(t.db, T0, id);
    return id;
  }

  /** A blocking item opened by hand, as the poller and others do. */
  async function blocking(
    sessionId: string,
    kind: "missing_driver" | "poll_gave_up",
    driverId: string | null,
  ) {
    const ctx = await getSessionContext(t.db, sessionId);
    await openReviewItem(t.db, T0, {
      kind,
      severity: "blocking",
      seasonId: ctx.seasonId,
      eventId: ctx.eventId,
      sessionId,
      driverId,
      details: driverId ? { driverId } : {},
      dedupeKey: `test:${kind}:${sessionId}:${driverId}`,
    });
    const [row] = await t.db
      .select()
      .from(reviewItems)
      .where(
        eq(reviewItems.dedupeKey, `test:${kind}:${sessionId}:${driverId}`),
      );
    return row!;
  }

  it('resolve team_change with "Update seats from this event on" closes the seat and opens the new one, resolves the item, and audits both in one transaction', async () => {
    const race = await raceWithRussellIn("ferrari");
    const russell = await idFor(t.db, "driver", "russell");
    const ferrari = await idFor(t.db, "constructor", "ferrari");
    const [open] = await t.db
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.sessionId, race),
          eq(reviewItems.kind, "team_change"),
        ),
      );
    expect(open).toBeDefined();

    const { status } = await resolveReviewItem(t.db, T1, ACTOR, {
      id: open!.id,
      version: open!.version,
      actionId: "update_seats",
      reason: "Russell moved to Ferrari",
    });
    expect(status).toBe("resolved");

    const seats = await t.db
      .select()
      .from(seatAssignments)
      .where(eq(seatAssignments.driverId, russell));
    expect(seats.find((s) => s.validTo === null)).toMatchObject({
      constructorId: ferrari,
    });
    expect(seats.filter((s) => s.validTo !== null)).toHaveLength(1);
    expect(await item(open!.id)).toMatchObject({
      status: "resolved",
      resolution: "Update seats from this event on",
      resolvedAt: T1,
    });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, "r1"));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "review_item.resolve",
      "seat_assignment.close",
      "seat_assignment.open",
    ]);
  });

  it('resolve missing_driver with "Mark unavailable" sets availability and moves the session on', async () => {
    const race = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
    const hadjar = await idFor(t.db, "driver", "hadjar");
    const missing = await blocking(race, "missing_driver", hadjar);
    expect((await advanceStatus(t.db, T0, race)).next).toBe("under_review");

    await resolveReviewItem(t.db, T1, ACTOR, {
      id: missing.id,
      version: missing.version,
      actionId: "mark_unavailable",
      reason: "He didn't start",
    });

    const [availability] = await t.db
      .select()
      .from(driverAvailability)
      .where(eq(driverAvailability.driverId, hadjar));
    expect(availability).toMatchObject({
      status: "unavailable",
      source: "admin",
    });
    expect(await statusOf(race)).toBe("provisional");
  });

  it('resolve event_missing_from_provider with "Mark cancelled" on an event that has since locked is refused with event_locked, item still open', async () => {
    const race = await sessionIdFor(t.db, 18, "race");
    const ctx = await getSessionContext(t.db, race);
    await openReviewItem(t.db, T0, {
      kind: "event_missing_from_provider",
      seasonId: ctx.seasonId,
      eventId: ctx.eventId,
      details: {},
      dedupeKey: "test:missing_event",
    });
    const [open] = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.dedupeKey, "test:missing_event"));

    const [lock] = await t.db
      .select({ lockAt: events.lockAt })
      .from(events)
      .where(eq(events.id, ctx.eventId));
    const afterLock = new Date(lock!.lockAt.getTime() + 3_600_000);
    await expect(
      resolveReviewItem(t.db, afterLock, ACTOR, {
        id: open!.id,
        version: open!.version,
        actionId: "mark_cancelled",
        reason: "Dropped from the calendar",
      }),
    ).rejects.toMatchObject({ code: "event_locked" });

    expect(await item(open!.id)).toMatchObject({
      status: "open",
      version: open!.version,
    });
    const [event] = await t.db
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, ctx.eventId));
    expect(event!.status).toBe("scheduled");
    expect(await reviewAudits()).toHaveLength(0);
  });

  it("two resolves at the same version: one succeeds, the other is refused with stale and writes no audit row", async () => {
    const race = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
    const gaveUp = await blocking(race, "poll_gave_up", null);
    const resolve = (reason: string) =>
      resolveReviewItem(t.db, T1, ACTOR, {
        id: gaveUp.id,
        version: gaveUp.version,
        actionId: "dismiss",
        reason,
      });
    const results = await Promise.allSettled([
      resolve("First"),
      resolve("Second"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale" },
    });
    const audits = await reviewAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "review_item.dismiss" });
    expect(await item(gaveUp.id)).toMatchObject({ status: "dismissed" });
  });

  describe("checking a stuck event again", () => {
    /** Round 18's event, and a review item of `kind` with `details`. */
    async function stuck(
      kind: "finalize_held" | "job_dead",
      details: (eventId: string) => Record<string, unknown>,
    ) {
      const { event } = await eventOfRound(t.db, 18);
      const eventId = event.id;
      await openReviewItem(t.db, T0, {
        kind,
        severity: "warning",
        seasonId: kind === "job_dead" ? null : event.seasonId,
        eventId: kind === "job_dead" ? null : eventId,
        details: details(eventId),
        dedupeKey: `test:${kind}`,
      });
      const [row] = await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `test:${kind}`));
      return { eventId, row: row! };
    }
    const finalizeJobs = (eventId: string) =>
      t.db
        .select()
        .from(jobs)
        .where(like(jobs.dedupeKey, `finalize:${eventId}:held:%`));
    const deadCheck = (eventId: string) => ({
      kind: "finalize_check",
      dedupe_key: `finalize:${eventId}:+48h`,
      attempts: 5,
      last_error: "Jolpica /2026/18/results.json: 403",
    });

    it('resolve finalize_held with "Check the event again now" queues a last check for now, after the held ones, and wakes the tick', async () => {
      const { eventId, row } = await stuck("finalize_held", () => ({
        recheckStopped: true,
      }));
      await enqueue(t.db, {
        kind: "finalize_check",
        dedupeKey: `finalize:${eventId}:held:3`,
        runAt: T0,
        payload: { eventId, afterHours: 48, final: true, held: 3 },
      });
      // It ran, held, and its window was over: nothing is due.
      await t.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.dedupeKey, `finalize:${eventId}:held:3`));
      const due = createMemoryDueStore();

      expect(
        (await reviewItem(t.db, row.id))!.actions.map((a) => a.id),
      ).toEqual(["check_again", "go_calendar", "dismiss"]);
      await resolveReviewItem(
        t.db,
        T1,
        ACTOR,
        {
          id: row.id,
          version: row.version,
          actionId: "check_again",
          reason: "Jolpica has fixed the grid",
        },
        due.store,
      );

      const queued = (await finalizeJobs(eventId)).find((j) =>
        j.dedupeKey.endsWith(":held:4"),
      );
      expect(queued).toMatchObject({
        kind: "finalize_check",
        status: "pending",
        runAt: T1,
        payload: { eventId, afterHours: 48, final: true, held: 4 },
      });
      expect((await item(row.id)).status).toBe("resolved");
      expect(await reviewAudits()).toHaveLength(1);
      expect(JSON.parse(due.objects.get(DUE_KEY)!).next_due_at).toBe(
        T1.toISOString(),
      );
    });

    it("job_dead for a finalize check offers the same action, finding the event in the job's key", async () => {
      const { eventId, row } = await stuck("job_dead", deadCheck);
      expect(
        (await reviewItem(t.db, row.id))!.actions.map((a) => a.id),
      ).toEqual(["check_again", "dismiss"]);

      await resolveReviewItem(t.db, T1, ACTOR, {
        id: row.id,
        version: row.version,
        actionId: "check_again",
        reason: "Jolpica answers again",
      });
      expect(
        (await finalizeJobs(eventId)).map((j) => [j.dedupeKey, j.runAt]),
      ).toEqual([[`finalize:${eventId}:held:1`, T1]]);
    });

    it("job_dead for any other job doesn't offer it, and refuses it", async () => {
      const { row } = await stuck("job_dead", () => ({
        kind: "sync_calendar",
        dedupe_key: "sync_calendar:2026:2026-11-24",
      }));
      expect(
        (await reviewItem(t.db, row.id))!.actions.map((a) => a.id),
      ).toEqual(["dismiss"]);
      await expect(
        resolveReviewItem(t.db, T1, ACTOR, {
          id: row.id,
          version: row.version,
          actionId: "check_again",
          reason: "try",
        }),
      ).rejects.toMatchObject({ code: "invalid" });
      expect((await item(row.id)).status).toBe("open");
    });

    it.each(["completed", "cancelled"] as const)(
      "refuses for a %s event, writing nothing",
      async (status) => {
        const { eventId, row } = await stuck("job_dead", deadCheck);
        await t.db.update(events).set({ status }).where(eq(events.id, eventId));
        const refused = resolveReviewItem(t.db, T1, ACTOR, {
          id: row.id,
          version: row.version,
          actionId: "check_again",
          reason: "try",
        });
        await expect(refused).rejects.toBeInstanceOf(StaffError);
        await expect(refused).rejects.toMatchObject({ code: "invalid" });
        expect(await finalizeJobs(eventId)).toEqual([]);
        expect((await item(row.id)).status).toBe("open");
      },
    );
  });

  it("a blocking item's resolution lets advanceStatus take the session to provisional", async () => {
    const race = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
    const gaveUp = await blocking(race, "poll_gave_up", null);
    expect((await advanceStatus(t.db, T0, race)).next).toBe("under_review");
    await resolveReviewItem(t.db, T1, ACTOR, {
      id: gaveUp.id,
      version: gaveUp.version,
      actionId: "dismiss",
      reason: "The results came in after all",
    });
    expect((await advanceStatus(t.db, T1, race)).next).toBe("provisional");
  });

  it("the held line names the sessions whose scoring the open blocking items hold", async () => {
    const race = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
    const quali = await ingestRecorded(
      t.db,
      T0,
      18,
      "qualifying",
      "r18-qualifying.json",
    );
    const one = await blocking(race, "poll_gave_up", null);
    await blocking(quali, "poll_gave_up", null);

    const view = await reviewItem(t.db, one.id);
    expect(view!.held).toMatch(
      /^Scoring is held for .+ GP qualifying and the race$/,
    );

    const list = await reviewList(t.db, { status: "open" });
    expect(list.map((i) => i.id)).toContain(one.id);
    expect(list[0]).toMatchObject({ severity: "blocking" });
  });

  it("a warning holds nothing, and a resolved item lists with its reason", async () => {
    const race = await sessionIdFor(t.db, 18, "race");
    const ctx = await getSessionContext(t.db, race);
    await openReviewItem(t.db, T0, {
      kind: "uncertain_event_match",
      seasonId: ctx.seasonId,
      eventId: ctx.eventId,
      details: { reason: "circuit_changed" },
      dedupeKey: "test:uncertain",
    });
    const [open] = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.dedupeKey, "test:uncertain"));
    expect((await reviewItem(t.db, open!.id))!.held).toBeNull();
    await expect(
      resolveReviewItem(t.db, T1, ACTOR, {
        id: open!.id,
        version: open!.version,
        actionId: "go_calendar",
        reason: "A link isn't a decision",
      }),
    ).rejects.toMatchObject({ code: "invalid" });

    await resolveReviewItem(t.db, T1, ACTOR, {
      id: open!.id,
      version: open!.version,
      actionId: "dismiss",
      reason: "Same event, new circuit name",
    });
    const done = await reviewList(t.db, { status: "resolved" });
    expect(done[0]).toMatchObject({
      id: open!.id,
      status: "dismissed",
      resolution: "Dismiss",
      reason: "Same event, new circuit name",
    });
  });
});
