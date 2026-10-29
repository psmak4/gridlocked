import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, like } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import {
  drivers,
  effectiveResults,
  events,
  jobs,
  providerRequests,
  resultChanges,
  sessions,
} from "@/db/schema";
import { replayWeekend, type ReplayReport } from "./harness";

// The 2026 replay harness (Task 11b): a whole race weekend, replayed from the
// recorded fixtures on a simulated clock with the real scheduler tick.

const FIXTURES = fileURLToPath(
  new URL("../../../tests/fixtures", import.meta.url),
);
// Round 18 (United States GP, a no-sprint weekend): qualifying ends
// 2026-10-24 22:00Z and the race 2026-10-25 22:00Z.
const RACE_END = "2026-10-25T22:00:00Z";

describe("replayWeekend", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const replay = (opts: Partial<Parameters<typeof replayWeekend>[1]> = {}) =>
    replayWeekend(t.db, {
      season: 2026,
      round: 18,
      fixturesDir: FIXTURES,
      ...opts,
    });

  async function raceOrder() {
    // By slug: each replay has its own database, so ids differ between them.
    const rows = await t.db
      .select({ slug: drivers.slug })
      .from(effectiveResults)
      .innerJoin(drivers, eq(drivers.id, effectiveResults.driverId))
      .innerJoin(sessions, eq(sessions.id, effectiveResults.sessionId))
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(
        and(eq(events.round, 18), eq(effectiveResults.sessionKind, "race")),
      )
      .orderBy(asc(effectiveResults.position));
    return rows.map((r) => r.slug);
  }

  it("takes round 18 to final and completed, with no review items", async () => {
    const report = await replay();

    expect(report.sessionStatuses).toEqual({
      qualifying: "final",
      race: "final",
    });
    expect(report.eventStatus).toBe("completed");
    expect(report.reviewItems).toEqual({});
    expect(report.resultChanges).toBe(0);
    expect(report.cancelledSessions).toEqual([]);
    // Two roster checks, four polls for qualifying and four for the race
    // (+0, +5, +20 min empty, +80 min published), and the four finalize
    // checks; every one succeeded.
    expect(report.jobs).toEqual({ succeeded: 14 });
    // The calendar sync recurs: the first safety tick (Friday 06:07 UTC)
    // finds none pending and starts the chain, then it runs at 06:00 UTC on
    // each of the four days after; Wednesday's is queued.
    expect(report.calendarSyncs).toEqual({ succeeded: 5, pending: 1 });
    // Every job and every sync ran at a minute of its own.
    expect(report.wakeTicks).toBe(14 + 5);
  });

  it("shows a late +5 s penalty as result_changes and a new order at the next finalize check", async () => {
    // Published at 22:30, first read at the 23:20 poll; the penalty lands at
    // 23:30, so the +2 h check (00:00) is the first to see it.
    const before = await replay({
      until: "2026-10-25T23:59:00Z",
      inject: [
        {
          at: "2026-10-25T23:30:00Z",
          kind: "penalty",
          driver: "max_verstappen",
          seconds: 5,
        },
      ],
    });
    expect(before.resultChanges).toBe(0);
    const unpenalised = await raceOrder();
    await t.close();

    t = await createTestDb();
    const after: ReplayReport = await replay({
      inject: [
        {
          at: "2026-10-25T23:30:00Z",
          kind: "penalty",
          driver: "max_verstappen",
          seconds: 5,
        },
      ],
    });
    const penalised = await raceOrder();

    expect(after.resultChanges).toBeGreaterThan(0);
    const changes = await t.db.select().from(resultChanges);
    // Verstappen (P3) and Hamilton (P4) swap, and nobody else moves. Their
    // position text, points and (for Verstappen) time change with it.
    expect(new Set(changes.map((c) => c.driverId)).size).toBe(2);
    expect(
      changes
        .filter((c) => c.field === "position")
        .map((c) => [c.oldValue, c.newValue])
        .sort(),
    ).toEqual([
      ["3", "4"],
      ["4", "3"],
    ]);
    expect(new Set(changes.map((c) => c.field))).toEqual(
      new Set([
        "position",
        "provider_position_text",
        "official_points",
        "time_ms",
      ]),
    );
    expect(unpenalised.slice(2, 4)).toEqual(["max-verstappen", "hamilton"]);
    expect(penalised.slice(2, 4)).toEqual(["hamilton", "max-verstappen"]);
    expect(penalised.slice(4)).toEqual(unpenalised.slice(4));

    // The new order is the final one: nothing is left for an admin.
    expect(after.sessionStatuses).toEqual({
      qualifying: "final",
      race: "final",
    });
    expect(after.eventStatus).toBe("completed");
    expect(after.reviewItems).toEqual({});
  });

  it("backs off through an outage from race end to +3 h and recovers, without giving up", async () => {
    const report = await replay({
      inject: [
        {
          at: RACE_END,
          kind: "outage",
          until: "2026-10-26T01:00:00Z",
        },
      ],
    });

    const [race] = await t.db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(and(eq(events.round, 18), eq(sessions.kind, "race")));
    const polls = await t.db
      .select({ runAt: jobs.runAt, status: jobs.status })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, "poll_session"),
          like(jobs.dedupeKey, `poll:${race!.id}:%`),
        ),
      )
      .orderBy(asc(jobs.runAt));
    // +0, +5, then +15, then hourly: the gaps grow and stay at an hour. The
    // 01:20 poll is the first after the outage, and it ends the chain.
    expect(polls.map((p) => p.runAt.toISOString())).toEqual([
      "2026-10-25T22:00:00.000Z",
      "2026-10-25T22:05:00.000Z",
      "2026-10-25T22:20:00.000Z",
      "2026-10-25T23:20:00.000Z",
      "2026-10-26T00:20:00.000Z",
      "2026-10-26T01:20:00.000Z",
    ]);
    expect(polls.every((p) => p.status === "succeeded")).toBe(true);

    // Every refused request fell inside the outage; none came after it.
    const refused = await t.db
      .select({ at: providerRequests.requestedAt })
      .from(providerRequests)
      .where(eq(providerRequests.statusCode, 503))
      .orderBy(asc(providerRequests.requestedAt));
    expect(refused.length).toBeGreaterThanOrEqual(5);
    for (const { at } of refused) {
      expect(at.toISOString() >= "2026-10-25T22:00:00.000Z").toBe(true);
      expect(at.toISOString() < "2026-10-26T01:00:00.000Z").toBe(true);
    }

    expect(report.reviewItems).toEqual({});
    expect(report.sessionStatuses).toEqual({
      qualifying: "final",
      race: "final",
    });
    expect(report.eventStatus).toBe("completed");
    expect(report.jobs).toEqual({ succeeded: 16 });
  });

  it("gives the same report when it steps every minute as when it jumps to the next due minute", async () => {
    const window = {
      from: "2026-10-25T21:50:00Z",
      until: "2026-10-26T02:00:00Z",
      inject: [
        {
          at: RACE_END,
          kind: "outage" as const,
          until: "2026-10-26T01:00:00Z",
        },
      ],
    };
    const jumped = await replay({ ...window, step: "jump" });
    await t.close();
    t = await createTestDb();
    const stepped = await replay({ ...window, step: "minute" });

    expect(stepped).toEqual(jumped);
    expect(jumped.wakeTicks).toBeGreaterThan(0);
  });

  it("cancels scored sessions that have no recorded results and leaves the rest to finish", async () => {
    // Round 12 (Dutch GP, a sprint weekend) has only its race recorded.
    const report = await replay({ round: 12 });

    expect(report.cancelledSessions).toEqual(["sprint", "qualifying"]);
    expect(report.sessionStatuses).toEqual({ race: "final" });
    expect(report.eventStatus).toBe("completed");
    const [event] = await t.db
      .select({ status: events.status })
      .from(events)
      .where(eq(events.round, 12));
    expect(event!.status).toBe("completed");
  });
});
