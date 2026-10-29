import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { jobs } from "@/db/schema";
import { simulatedClock, type Timer } from "@/lib/clock";
import { claimNext, enqueue } from "./queue";
import { runDue, type JobHandler } from "./runner";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const OPTS = { maxJobs: 10, leaseMs: 5 * 60_000 };

describe("runDue", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const job = (
    dedupeKey: string,
    extra: { kind?: string; runAt?: Date } = {},
  ) =>
    enqueue(t.db, {
      kind: extra.kind ?? "k",
      dedupeKey,
      runAt: extra.runAt ?? T0,
      payload: { dedupeKey },
    });

  async function row(id: string) {
    const [r] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    return r!;
  }

  it("runs due jobs, passes the job and context, and completes them", async () => {
    const clock = simulatedClock(T0);
    const a = await job("a");
    const seen: string[] = [];
    const handler: JobHandler = async (j, ctx) => {
      expect(ctx.db).toBe(t.db);
      expect(ctx.clock).toBe(clock);
      seen.push(j.id);
    };
    const res = await runDue(t.db, clock, { k: handler }, OPTS);
    expect(res).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(seen).toEqual([a.id]);
    expect((await row(a.id)).status).toBe("succeeded");
  });

  it("does not run jobs that are not yet due", async () => {
    await job("a", { runAt: new Date(T0.getTime() + 1) });
    const res = await runDue(
      t.db,
      simulatedClock(T0),
      { k: async () => {} },
      OPTS,
    );
    expect(res).toEqual({ ran: 0, failed: 0, lost: 0 });
  });

  it("stops after maxJobs", async () => {
    await job("a");
    await job("b");
    await job("c");
    const res = await runDue(
      t.db,
      simulatedClock(T0),
      { k: async () => {} },
      { ...OPTS, maxJobs: 2 },
    );
    expect(res).toEqual({ ran: 2, failed: 0, lost: 0 });
    const left = await runDue(
      t.db,
      simulatedClock(T0),
      { k: async () => {} },
      OPTS,
    );
    expect(left).toEqual({ ran: 1, failed: 0, lost: 0 });
  });

  it("records a handler error as failed, never throws, and retries after the backoff", async () => {
    const clock = simulatedClock(T0);
    const a = await job("a");
    let calls = 0;
    const handler: JobHandler = async () => {
      calls++;
      if (calls === 1) throw new Error("provider down");
    };
    const first = await runDue(t.db, clock, { k: handler }, OPTS);
    expect(first).toEqual({ ran: 0, failed: 1, lost: 0 });
    expect(await row(a.id)).toMatchObject({
      status: "failed",
      lastError: "provider down",
    });

    // Still inside the 1 minute backoff: nothing is due.
    clock.advance(30_000);
    expect(await runDue(t.db, clock, { k: handler }, OPTS)).toEqual({
      ran: 0,
      failed: 0,
      lost: 0,
    });

    clock.advance(30_000);
    const second = await runDue(t.db, clock, { k: handler }, OPTS);
    expect(second).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect((await row(a.id)).status).toBe("succeeded");
    expect(calls).toBe(2);
  });

  it("does not loop on a job it just failed (backoff is in the future)", async () => {
    await job("a");
    const res = await runDue(
      t.db,
      simulatedClock(T0),
      {
        k: async () => {
          throw new Error("x");
        },
      },
      OPTS,
    );
    expect(res).toEqual({ ran: 0, failed: 1, lost: 0 });
  });

  it("fails a job with no handler for its kind", async () => {
    const a = await job("a", { kind: "mystery" });
    const res = await runDue(t.db, simulatedClock(T0), {}, OPTS);
    expect(res).toEqual({ ran: 0, failed: 1, lost: 0 });
    expect(await row(a.id)).toMatchObject({
      status: "failed",
      lastError: "no handler for kind mystery",
    });
  });

  it("records a non-Error throw as a string", async () => {
    const a = await job("a");
    await runDue(
      t.db,
      simulatedClock(T0),
      {
        k: async () => {
          throw "plain string";
        },
      },
      OPTS,
    );
    expect((await row(a.id)).lastError).toBe("plain string");
  });

  it("does not treat Object.prototype names as handlers", async () => {
    const a = await job("a", { kind: "toString" });
    const res = await runDue(t.db, simulatedClock(T0), {}, OPTS);
    expect(res).toEqual({ ran: 0, failed: 1, lost: 0 });
    expect((await row(a.id)).lastError).toBe("no handler for kind toString");
  });
  it("dead-letters an expired lease past max_attempts at the start of a run", async () => {
    const a = await enqueue(t.db, {
      kind: "k",
      dedupeKey: "p",
      runAt: T0,
      payload: {},
      maxAttempts: 1,
    });
    await claimNext(t.db, T0, OPTS.leaseMs);
    const clock = simulatedClock(new Date(T0.getTime() + OPTS.leaseMs));
    const res = await runDue(t.db, clock, { k: async () => {} }, OPTS);
    expect(res).toEqual({ ran: 0, failed: 0, lost: 0 });
    expect(await row(a.id)).toMatchObject({
      status: "dead",
      lastError: "lease expired after max attempts",
    });
  });

  it("counts a fenced-out result as lost, neither ran nor failed", async () => {
    const clock = simulatedClock(T0);
    const a = await job("a");
    // The handler outlives its lease; another worker reclaims the job.
    const slow: JobHandler = async () => {
      clock.advance(OPTS.leaseMs);
      await claimNext(t.db, clock.now(), OPTS.leaseMs);
    };
    const res = await runDue(t.db, clock, { k: slow }, OPTS);
    expect(res).toEqual({ ran: 0, failed: 0, lost: 1 });
    expect(await row(a.id)).toMatchObject({ status: "running", attempts: 2 });
  });

  it("counts a fenced-out failure as lost", async () => {
    const clock = simulatedClock(T0);
    await job("a");
    const slow: JobHandler = async () => {
      clock.advance(OPTS.leaseMs);
      await claimNext(t.db, clock.now(), OPTS.leaseMs);
      throw new Error("late");
    };
    const res = await runDue(t.db, clock, { k: slow }, OPTS);
    expect(res).toEqual({ ran: 0, failed: 0, lost: 1 });
  });

  describe("deadlineMs", () => {
    /** A timer on its own clock: only the handlers move it. */
    function setup() {
      let now = 1_000_000;
      const timer: Timer = {
        now: () => now,
        sleep: async (ms) => void (now += ms),
      };
      return { timer, advance: (ms: number) => void (now += ms) };
    }

    it("stops claiming new jobs once the timer passes start + deadlineMs, and leaves the rest pending", async () => {
      const { timer, advance } = setup();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await job(`j${i}`)).id);
      const seen: string[] = [];
      const handler: JobHandler = async (j) => {
        seen.push(j.id);
        advance(400); // each job takes 400 ms of real time
      };
      const res = await runDue(
        t.db,
        simulatedClock(T0),
        { k: handler },
        { ...OPTS, deadlineMs: 1000, timer },
      );
      // Claims at +0, +400 and +800 ms; at +1200 ms the deadline has passed.
      expect(res).toEqual({ ran: 3, failed: 0, lost: 0 });
      expect(seen).toHaveLength(3);
      const statuses = await Promise.all(ids.map((id) => row(id)));
      expect(statuses.filter((r) => r.status === "pending")).toHaveLength(2);
    });

    it("finishes the job it is running when the deadline passes mid-job", async () => {
      const { timer, advance } = setup();
      const a = await job("a");
      await job("b");
      const res = await runDue(
        t.db,
        simulatedClock(T0),
        { k: async () => advance(5_000) },
        { ...OPTS, deadlineMs: 1000, timer },
      );
      expect(res.ran).toBe(1);
      expect((await row(a.id)).status).toBe("succeeded");
    });

    it("claims nothing when the deadline is already used up", async () => {
      const { timer } = setup();
      await job("a");
      const res = await runDue(
        t.db,
        simulatedClock(T0),
        { k: async () => {} },
        { ...OPTS, deadlineMs: 0, timer },
      );
      expect(res).toEqual({ ran: 0, failed: 0, lost: 0 });
    });

    it("has no deadline by default", async () => {
      for (let i = 0; i < 4; i++) await job(`j${i}`);
      const res = await runDue(
        t.db,
        simulatedClock(T0),
        { k: async () => {} },
        OPTS,
      );
      expect(res.ran).toBe(4);
    });
  });
});
