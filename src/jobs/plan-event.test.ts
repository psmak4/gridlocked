import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedResultsWorld } from "../../tests/helpers/results-2026";
import { allJobs, eventOfRound } from "../../tests/helpers/pipeline-2026";
import { events, jobs, sessions, settings } from "@/db/schema";
import { planEventJobs } from "./plan-event";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("planEventJobs", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await seedResultsWorld(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  /** `dedupe_key -> run_at (ISO)` for every planned job. */
  async function planned() {
    return Object.fromEntries(
      (await allJobs(t.db)).map((j) => [j.dedupeKey, j.runAt.toISOString()]),
    );
  }
  const at = (d: Date, ms = 0) => new Date(d.getTime() + ms).toISOString();

  it("plans round 18: a poll per scored session, four finalizer checks, two roster checks", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    const by = Object.fromEntries(s.map((x) => [x.kind, x]));
    await planEventJobs(t.db, event.id);

    expect(await planned()).toEqual({
      [`roster:${event.id}:fp2`]: at(by.fp2!.scheduledEnd, 30 * MIN),
      [`roster:${event.id}:fp3`]: at(by.fp3!.scheduledEnd, 30 * MIN),
      [`poll:${by.qualifying!.id}:start`]: at(by.qualifying!.scheduledEnd),
      [`poll:${by.race!.id}:start`]: at(by.race!.scheduledEnd),
      [`finalize:${event.id}:+2h`]: at(by.race!.scheduledEnd, 2 * HOUR),
      [`finalize:${event.id}:+6h`]: at(by.race!.scheduledEnd, 6 * HOUR),
      [`finalize:${event.id}:+24h`]: at(by.race!.scheduledEnd, 24 * HOUR),
      [`finalize:${event.id}:+48h`]: at(by.race!.scheduledEnd, 48 * HOUR),
    });
  });

  it("uses the right kind and payload for each job", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    await planEventJobs(t.db, event.id);
    const rows = await allJobs(t.db);
    const find = (key: string) => rows.find((j) => j.dedupeKey === key)!;
    const race = s.find((x) => x.kind === "race")!;
    const fp2 = s.find((x) => x.kind === "fp2")!;

    expect(find(`poll:${race.id}:start`)).toMatchObject({
      kind: "poll_session",
      status: "pending",
      payload: { sessionId: race.id, attempt: 0 },
    });
    expect(find(`finalize:${event.id}:+6h`)).toMatchObject({
      kind: "finalize_check",
      payload: { eventId: event.id, afterHours: 6, final: false },
    });
    expect(find(`finalize:${event.id}:+48h`).payload).toMatchObject({
      final: true,
    });
    expect(find(`roster:${event.id}:fp2`)).toMatchObject({
      kind: "roster_check",
      payload: { eventId: event.id, sessionId: fp2.id },
    });
  });

  it("plans a sprint weekend: a sprint poll, none for sprint qualifying, no roster checks", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 2);
    expect(s.map((x) => x.kind)).toContain("sprint_qualifying");
    await planEventJobs(t.db, event.id);
    const keys = (await allJobs(t.db)).map((j) => j.dedupeKey);
    const sprint = s.find((x) => x.kind === "sprint")!;
    const sq = s.find((x) => x.kind === "sprint_qualifying")!;

    expect(keys).toContain(`poll:${sprint.id}:start`);
    expect(keys.some((k) => k.includes(sq.id))).toBe(false);
    expect(keys.some((k) => k.startsWith("roster:"))).toBe(false);
    expect(keys.filter((k) => k.startsWith("poll:"))).toHaveLength(3);
  });

  it("is idempotent: planning twice leaves the same jobs", async () => {
    const { event } = await eventOfRound(t.db, 18);
    await planEventJobs(t.db, event.id);
    const first = await planned();
    await planEventJobs(t.db, event.id);
    expect(await planned()).toEqual(first);
    expect(await allJobs(t.db)).toHaveLength(8);
  });

  it("moving qualifying 30 minutes later moves only its poll job", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    const quali = s.find((x) => x.kind === "qualifying")!;
    await planEventJobs(t.db, event.id);
    const before = await planned();

    await t.db
      .update(sessions)
      .set({
        scheduledStart: new Date(quali.scheduledStart.getTime() + 30 * MIN),
        scheduledEnd: new Date(quali.scheduledEnd.getTime() + 30 * MIN),
      })
      .where(eq(sessions.id, quali.id));
    await planEventJobs(t.db, event.id);
    const after = await planned();

    const key = `poll:${quali.id}:start`;
    expect(after[key]).toBe(at(quali.scheduledEnd, 30 * MIN));
    const without = (jobsByKey: Record<string, string>) =>
      Object.entries(jobsByKey).filter(([k]) => k !== key);
    expect(without(after)).toEqual(without(before));
    expect(Object.keys(after)).toHaveLength(8);
  });

  it("moving the race moves its poll and every finalizer check", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    const race = s.find((x) => x.kind === "race")!;
    await planEventJobs(t.db, event.id);
    await t.db
      .update(sessions)
      .set({ scheduledEnd: new Date(race.scheduledEnd.getTime() + 3 * HOUR) })
      .where(eq(sessions.id, race.id));
    await planEventJobs(t.db, event.id);
    const after = await planned();

    const end = new Date(race.scheduledEnd.getTime() + 3 * HOUR);
    expect(after[`poll:${race.id}:start`]).toBe(at(end));
    expect(after[`finalize:${event.id}:+48h`]).toBe(at(end, 48 * HOUR));
    expect(Object.keys(after)).toHaveLength(8);
  });

  it("does not move a poll job that already ran", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    const race = s.find((x) => x.kind === "race")!;
    await planEventJobs(t.db, event.id);
    await t.db
      .update(jobs)
      .set({ status: "succeeded" })
      .where(eq(jobs.dedupeKey, `poll:${race.id}:start`));
    await t.db
      .update(sessions)
      .set({ scheduledEnd: new Date(race.scheduledEnd.getTime() + HOUR) })
      .where(eq(sessions.id, race.id));
    await planEventJobs(t.db, event.id);

    expect((await planned())[`poll:${race.id}:start`]).toBe(
      at(race.scheduledEnd),
    );
  });

  it("plans nothing for a cancelled event", async () => {
    const { event } = await eventOfRound(t.db, 18);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, event.id));
    await planEventJobs(t.db, event.id);
    expect(await allJobs(t.db)).toEqual([]);
  });

  it("skips a cancelled session but plans the rest", async () => {
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    const fp3 = s.find((x) => x.kind === "fp3")!;
    const quali = s.find((x) => x.kind === "qualifying")!;
    await t.db
      .update(sessions)
      .set({ status: "cancelled" })
      .where(eq(sessions.id, fp3.id));
    await t.db
      .update(sessions)
      .set({ status: "cancelled" })
      .where(eq(sessions.id, quali.id));
    await planEventJobs(t.db, event.id);
    const keys = Object.keys(await planned());

    expect(keys).not.toContain(`roster:${event.id}:fp3`);
    expect(keys).not.toContain(`poll:${quali.id}:start`);
    expect(keys).toContain(`roster:${event.id}:fp2`);
    expect(keys).toHaveLength(6);
  });

  it("takes the finalizer checks from the setting", async () => {
    await t.db.insert(settings).values({
      key: "finalizer_checks",
      value: { afterHours: [1, 12] },
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const { event, sessions: s } = await eventOfRound(t.db, 18);
    const race = s.find((x) => x.kind === "race")!;
    await planEventJobs(t.db, event.id);
    const p = await planned();

    expect(p[`finalize:${event.id}:+1h`]).toBe(at(race.scheduledEnd, HOUR));
    expect(p[`finalize:${event.id}:+12h`]).toBe(
      at(race.scheduledEnd, 12 * HOUR),
    );
    expect(
      Object.keys(p).filter((k) => k.startsWith("finalize:")),
    ).toHaveLength(2);
    const last = (await allJobs(t.db)).find(
      (j) => j.dedupeKey === `finalize:${event.id}:+12h`,
    )!;
    expect(last.payload).toMatchObject({ final: true });
  });

  it("throws for an unknown event", async () => {
    await expect(
      planEventJobs(t.db, "0198f3e0-0000-7000-8000-000000000000"),
    ).rejects.toThrow(/no event/);
  });
});
