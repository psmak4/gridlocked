import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { loadSeats2026 } from "../../../tests/helpers/seats-2026";
import {
  events,
  rawSnapshots,
  reviewItems,
  sessionParticipants,
  sessionResultState,
  sessions,
} from "@/db/schema";
import { fixedClock } from "@/lib/clock";
import { hashParams } from "../snapshots";
import { importSeason2026 } from "./import-season";

// The 2026 import (Task 11a): every recorded fixture goes in as a raw
// snapshot, through the same normalizer and status advance the pipeline uses,
// and a second run changes nothing.

const FIXTURES = fileURLToPath(
  new URL("../../../tests/fixtures", import.meta.url),
);
const T1 = new Date("2026-10-28T09:00:00.000Z");
const T2 = new Date("2026-10-28T10:00:00.000Z");

/** Every recorded scored session: round, kind, and where it should end up. */
const RECORDED: Array<[number, string, string]> = [
  [1, "race", "provisional"],
  [2, "race", "provisional"],
  [2, "sprint", "provisional"],
  [12, "race", "provisional"],
  [13, "race", "provisional"],
  [14, "race", "provisional"],
  [15, "race", "provisional"],
  [16, "race", "provisional"],
  [17, "race", "provisional"],
  [18, "qualifying", "provisional"],
  [18, "race", "provisional"],
  // The empty body: nothing to show yet.
  [23, "race", "awaiting"],
];

describe("importSeason2026", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const run = (at = T1) => importSeason2026(t.db, fixedClock(at), FIXTURES);

  async function statusOf(round: number, kind: string) {
    const [row] = await t.db
      .select({ status: sessionResultState.status })
      .from(sessions)
      .innerJoin(events, eq(events.id, sessions.eventId))
      .leftJoin(
        sessionResultState,
        eq(sessionResultState.sessionId, sessions.id),
      )
      .where(and(eq(events.round, round), eq(sessions.kind, kind as "race")));
    return row?.status;
  }

  it("takes every recorded scored session to provisional, the empty one stays awaiting", async () => {
    await run();
    for (const [round, kind, expected] of RECORDED) {
      expect(await statusOf(round, kind), `r${round} ${kind}`).toBe(expected);
    }
  });

  it("opens no blocking review item", async () => {
    const report = await run();
    const blocking = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.severity, "blocking"));
    expect(blocking).toEqual([]);
    expect(report.reviewItems.openBlocking).toBe(0);
  });

  it("reports what is in every table afterwards", async () => {
    const report = await run();
    expect(report.rows.events).toBe(23);
    expect(report.rows.seat_assignments).toBe(loadSeats2026().length);
    expect(report.rows.raw_snapshots).toBe(20);
    expect(report.rows.results).toBeGreaterThan(200);
    expect(report.sessionStatuses).toEqual({ provisional: 11, awaiting: 1 });
  });

  it("does not plan or run jobs, finalize or call a provider", async () => {
    const report = await run();
    expect(report.rows.jobs).toBe(0);
    expect(report.rows.provider_requests).toBe(0);
    expect(report.sessionStatuses.final).toBeUndefined();
  });

  it("stores each fixture under the endpoint and params live polling uses", async () => {
    await run();
    const stored = async (paramsHash: string) =>
      t.db
        .select()
        .from(rawSnapshots)
        .where(eq(rawSnapshots.paramsHash, paramsHash));
    const limit = { limit: "100" };
    for (const [provider, endpoint, params] of [
      ["jolpica", "/2026.json", limit],
      ["jolpica", "/2026/drivers.json", limit],
      ["jolpica", "/2026/constructors.json", limit],
      ["jolpica", "/2026/1/results.json", limit],
      ["jolpica", "/2026/2/sprint.json", limit],
      ["jolpica", "/2026/18/qualifying.json", limit],
      ["openf1", "/sessions", { year: "2026" }],
    ] as const) {
      const rows = await stored(hashParams(provider, endpoint, { ...params }));
      expect(rows, `${provider} ${endpoint}`).toHaveLength(1);
      expect(rows[0]!.provider).toBe(provider);
      expect(rows[0]!.endpoint).toBe(endpoint);
      expect(rows[0]!.firstFetchedAt).toEqual(T1);
    }
  });

  it("links a results snapshot to its session and makes it the session's current one", async () => {
    await run();
    const [state] = await t.db
      .select({
        current: sessionResultState.currentSnapshotId,
        snapshotSession: rawSnapshots.sessionId,
        sessionId: sessionResultState.sessionId,
      })
      .from(sessionResultState)
      .innerJoin(
        rawSnapshots,
        eq(rawSnapshots.id, sessionResultState.currentSnapshotId),
      )
      .limit(1);
    expect(state?.snapshotSession).toBe(state?.sessionId);
  });

  it("stores the recorded practice participants and checks the roster", async () => {
    await run();
    const rows = await t.db.select().from(sessionParticipants);
    expect(rows.length).toBeGreaterThan(60);
    expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(["openf1"]));
    // Warnings may be raised for real surprises, but never anything blocking.
    const open = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.status, "open"));
    expect(open.every((i) => i.severity === "warning")).toBe(true);
  });

  it("is idempotent: a second run gives the same report and writes nothing new", async () => {
    const first = await run(T1);
    const snapshotsBefore = await t.db.select().from(rawSnapshots);
    const second = await run(T2);
    expect(second).toEqual(first);

    const snapshotsAfter = await t.db.select().from(rawSnapshots);
    expect(snapshotsAfter.map((s) => s.id).sort()).toEqual(
      snapshotsBefore.map((s) => s.id).sort(),
    );
    // The repeat only says when it saw the same answers again.
    expect(
      snapshotsAfter.every((s) => s.firstFetchedAt.getTime() === T1.getTime()),
    ).toBe(true);
    expect(
      snapshotsAfter.every((s) => s.lastSeenAt.getTime() === T2.getTime()),
    ).toBe(true);
  });
});
