import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { auditLog, events, settings } from "@/db/schema";
import { DUE_KEY, parseDueFile, publishDueTimes } from "@/jobs/due-times";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { tick, type TickDeps } from "@/jobs/tick";
import { setSetting } from "@/settings/write";
import { StaffError } from "@/staff/errors";
import type { StaffActor } from "@/staff/roster";
import { setSimulatedClock } from "./clock-loop";
import {
  hostedReplayNow,
  jumpReplay,
  pauseReplay,
  resumeReplay,
} from "./hosted-clock";

// The replay clock for a hosted beta (M9 Task 5): `replay_offset` turns the
// tick's real minute into the replay's instant, which never moves back, and
// a jump stops short of the next lock.

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const ADMIN: StaffActor = { kind: "admin", label: null };
const MIN = 60_000;
/** The replay's Friday morning, and the real Friday it lines up with. */
const SIM = new Date("2026-03-06T10:00:00.000Z");
const REAL = new Date("2026-12-11T10:00:00.000Z");
const OFFSET = (REAL.getTime() - SIM.getTime()) / 1000;
const later = (at: Date, minutes: number) =>
  new Date(at.getTime() + minutes * MIN);

async function clockRow(t: TestDb): Promise<string> {
  const [row] = await t.db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "simulated_clock"));
  return (row!.value as { at: string }).at;
}

describe("the hosted replay clock (M9 Task 5)", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  /** A replay database at SIM, running with the offset that lines up REAL. */
  async function running() {
    await setSimulatedClock(t.db, SIM);
    await setSetting(t.db, SIM, ADMIN, {
      key: "replay_offset",
      value: { mode: "running", seconds: OFFSET },
      reason: "Line the replay up with the beta",
    });
  }

  it("a running offset sets the clock to real time minus the offset", async () => {
    await running();
    const now = await hostedReplayNow(t.db, later(REAL, 30));
    expect(now.toISOString()).toBe("2026-03-06T10:30:00.000Z");
    expect(await clockRow(t)).toBe("2026-03-06T10:30:00.000Z");
  });

  it("the clock never moves backwards: a smaller offset holds the clock until real time catches up", async () => {
    await running();
    await hostedReplayNow(t.db, later(REAL, 30));
    // An hour further back: the replay's instant from it is an hour earlier.
    await setSetting(t.db, later(SIM, 30), ADMIN, {
      key: "replay_offset",
      value: { mode: "running", seconds: OFFSET + 3600 },
      reason: "Give the testers an hour more",
    });
    expect((await hostedReplayNow(t.db, later(REAL, 31))).toISOString()).toBe(
      "2026-03-06T10:30:00.000Z",
    );
    expect((await hostedReplayNow(t.db, later(REAL, 90))).toISOString()).toBe(
      "2026-03-06T10:30:00.000Z",
    );
    expect((await hostedReplayNow(t.db, later(REAL, 120))).toISOString()).toBe(
      "2026-03-06T11:00:00.000Z",
    );
    expect(await clockRow(t)).toBe("2026-03-06T11:00:00.000Z");
  });

  it("paused holds the clock where it stopped", async () => {
    await running();
    const stopped = await pauseReplay(t.db, later(REAL, 30), ADMIN, {
      reason: "A break between sessions",
    });
    expect(stopped.toISOString()).toBe("2026-03-06T10:30:00.000Z");
    expect((await hostedReplayNow(t.db, later(REAL, 300))).toISOString()).toBe(
      "2026-03-06T10:30:00.000Z",
    );
    // Resuming carries on from there.
    await resumeReplay(t.db, later(REAL, 300), ADMIN, { reason: "Back on" });
    expect((await hostedReplayNow(t.db, later(REAL, 310))).toISOString()).toBe(
      "2026-03-06T10:40:00.000Z",
    );
    const reasons = (await t.db.select().from(auditLog)).map((r) => r.reason);
    expect(reasons).toEqual([
      "Line the replay up with the beta",
      "A break between sessions",
      "Back on",
    ]);
  });

  it("a jump past a lock stops one minute before it, with jumped_to_lock", async () => {
    await running();
    // Monaco's lock: Saturday 14:00 in the replay.
    await seedEventSessions(t.db, new Date("2026-03-07T14:00:00.000Z"));
    const jumped = await jumpReplay(t.db, REAL, ADMIN, {
      to: new Date("2026-03-08T12:00:00.000Z"),
      reason: "Skip to Sunday",
    });
    expect(jumped).toEqual({
      status: "jumped_to_lock",
      at: new Date("2026-03-07T13:59:00.000Z"),
    });
    expect((await hostedReplayNow(t.db, REAL)).toISOString()).toBe(
      "2026-03-07T13:59:00.000Z",
    );
    // Real time runs on from there.
    expect((await hostedReplayNow(t.db, later(REAL, 5))).toISOString()).toBe(
      "2026-03-07T14:04:00.000Z",
    );
  });

  it("a jump that passes no lock lands where it was asked", async () => {
    await running();
    await seedEventSessions(t.db, new Date("2026-03-07T14:00:00.000Z"));
    expect(
      await jumpReplay(t.db, REAL, ADMIN, {
        to: new Date("2026-03-07T09:00:00.000Z"),
        reason: "Skip to Saturday morning",
      }),
    ).toEqual({ status: "jumped", at: new Date("2026-03-07T09:00:00.000Z") });
  });

  it("a cancelled event's lock doesn't stop a jump", async () => {
    await running();
    await seedEventSessions(t.db, new Date("2026-03-07T14:00:00.000Z"));
    await t.db.update(events).set({ status: "cancelled" });
    expect(
      (
        await jumpReplay(t.db, REAL, ADMIN, {
          to: new Date("2026-03-08T12:00:00.000Z"),
          reason: "Skip the cancelled round",
        })
      ).status,
    ).toBe("jumped");
  });

  it("a jump while paused stays paused, at its landing", async () => {
    await running();
    await pauseReplay(t.db, REAL, ADMIN, { reason: "Pause" });
    await jumpReplay(t.db, REAL, ADMIN, {
      to: new Date("2026-03-07T09:00:00.000Z"),
      reason: "Next morning",
    });
    expect((await hostedReplayNow(t.db, later(REAL, 60))).toISOString()).toBe(
      "2026-03-07T09:00:00.000Z",
    );
  });

  it("a jump backwards is refused with clock_backwards, writing nothing", async () => {
    await running();
    const before = await t.db.select().from(auditLog);
    await expect(
      jumpReplay(t.db, later(REAL, 30), ADMIN, {
        to: new Date("2026-03-06T10:00:00.000Z"),
        reason: "Back to the start",
      }),
    ).rejects.toEqual(new StaffError("clock_backwards"));
    expect(await t.db.select().from(auditLog)).toEqual(before);
  });

  it("the replay can't be moved on a database with a real clock: not_replay", async () => {
    await expect(
      pauseReplay(t.db, REAL, ADMIN, { reason: "Pause" }),
    ).rejects.toEqual(new StaffError("not_replay"));
  });

  it("the published file carries the replay, so the next tick needs no database", async () => {
    await running();
    const m = createMemoryDueStore();
    await publishDueTimes(t.db, m.store, SIM);
    const parsed = parseDueFile(m.objects.get(DUE_KEY) ?? null);
    expect(parsed.ok && parsed.file.replay).toEqual({
      floor: SIM.toISOString(),
      seconds: OFFSET,
    });
  });
});

describe("the tick on a hosted replay (M9 Task 5)", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  function setup(mode: "system" | "replay") {
    const m = createMemoryDueStore();
    const db = vi.fn(() => t.db);
    const seen: string[] = [];
    const handler: JobHandler = async (job, ctx) => {
      seen.push(`${job.dedupeKey}@${ctx.clock.now().toISOString()}`);
    };
    const deps: TickDeps = {
      db,
      store: m.store,
      mode,
      hostedReplay: true,
      handlers: async () => ({ k: handler }),
    };
    return { m, db, seen, deps };
  }

  it("runs a job on the replay's instant, given the real minute", async () => {
    await setSimulatedClock(t.db, SIM);
    await setSetting(t.db, SIM, ADMIN, {
      key: "replay_offset",
      value: { mode: "running", seconds: OFFSET },
      reason: "Line up",
    });
    await enqueue(t.db, {
      kind: "k",
      dedupeKey: "fp1",
      runAt: later(SIM, 30),
      payload: {},
    });
    const { m, db, seen, deps } = setup("replay");
    await publishDueTimes(t.db, m.store, SIM);

    // Real 10:10 is replay 10:10: nothing due, and the database stays shut.
    db.mockClear();
    expect((await tick(deps, later(REAL, 10))).action).toBe("sleep");
    expect(db).not.toHaveBeenCalled();

    expect((await tick(deps, later(REAL, 30))).action).toBe("wake");
    expect(seen).toEqual(["fp1@2026-03-06T10:30:00.000Z"]);
    expect(await clockRow(t)).toBe("2026-03-06T10:30:00.000Z");
  });

  it("the tick in system mode ignores replay_offset", async () => {
    await t.db.insert(settings).values({
      key: "replay_offset",
      value: { mode: "running", seconds: OFFSET },
    });
    await enqueue(t.db, {
      kind: "k",
      dedupeKey: "now",
      runAt: REAL,
      payload: {},
    });
    const { m, seen, deps } = setup("system");
    await publishDueTimes(t.db, m.store, REAL);
    expect((await tick(deps, REAL)).action).toBe("wake");
    expect(seen).toEqual(["now@2026-12-11T10:00:00.000Z"]);
    const rows = await t.db.execute(
      sql`select 1 from settings where key = 'simulated_clock'`,
    );
    expect(rows.rows).toHaveLength(0);
  });
});
