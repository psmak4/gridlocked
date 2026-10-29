import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { jobs, reviewItems } from "@/db/schema";
import { claimNext, complete, enqueue, fail, reapExpired } from "./queue";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const LEASE = 5 * 60_000;

describe("job queue", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  async function row(id: string) {
    const [r] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    return r!;
  }

  // The test claimed the job just before, so the stored row is the claimed one.
  const completeId = async (id: string, now: Date) =>
    complete(t.db, await row(id), now);
  const failId = async (id: string, now: Date, error: string) =>
    fail(t.db, await row(id), now, error);

  const base = {
    kind: "poll_session",
    dedupeKey: "poll:s1:1",
    runAt: T0,
    payload: { sessionId: "s1" },
  };

  describe("enqueue", () => {
    it("inserts a pending job with defaults", async () => {
      const res = await enqueue(t.db, base);
      expect(res.created).toBe(true);
      const r = await row(res.id);
      expect(r.status).toBe("pending");
      expect(r.attempts).toBe(0);
      expect(r.maxAttempts).toBe(5);
      expect(r.runAt).toEqual(T0);
      expect(r.payload).toEqual({ sessionId: "s1" });
    });

    it("honours maxAttempts", async () => {
      const res = await enqueue(t.db, { ...base, maxAttempts: 3 });
      expect((await row(res.id)).maxAttempts).toBe(3);
    });

    it("keeps one row per key and lets the second runAt and payload win while pending", async () => {
      const a = await enqueue(t.db, base);
      const b = await enqueue(t.db, {
        ...base,
        runAt: minutes(30),
        payload: { sessionId: "s1", moved: true },
      });
      expect(b).toEqual({ id: a.id, created: false });
      expect(await t.db.select().from(jobs)).toHaveLength(1);
      const r = await row(a.id);
      expect(r.runAt).toEqual(minutes(30));
      expect(r.payload).toEqual({ sessionId: "s1", moved: true });
    });

    it("treats the same dedupe key under another kind as a different job", async () => {
      const a = await enqueue(t.db, base);
      const b = await enqueue(t.db, { ...base, kind: "normalize" });
      expect(b.created).toBe(true);
      expect(b.id).not.toBe(a.id);
    });

    it("updates a failed job (it is waiting for a retry)", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      await failId(a.id, T0, "boom");
      const b = await enqueue(t.db, { ...base, runAt: minutes(60) });
      expect(b).toEqual({ id: a.id, created: false });
      const r = await row(a.id);
      expect(r.status).toBe("failed");
      expect(r.runAt).toEqual(minutes(60));
    });

    it("never touches a running job", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      const b = await enqueue(t.db, { ...base, runAt: minutes(60) });
      expect(b).toEqual({ id: a.id, created: false });
      const r = await row(a.id);
      expect(r.status).toBe("running");
      expect(r.runAt).toEqual(T0);
    });

    it("never touches a succeeded job", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      await completeId(a.id, minutes(1));
      const b = await enqueue(t.db, {
        ...base,
        runAt: minutes(60),
        payload: { other: 1 },
      });
      expect(b).toEqual({ id: a.id, created: false });
      const r = await row(a.id);
      expect(r.status).toBe("succeeded");
      expect(r.runAt).toEqual(T0);
      expect(r.payload).toEqual({ sessionId: "s1" });
    });

    it("never touches a dead job", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 1 });
      await claimNext(t.db, T0, LEASE);
      await failId(a.id, T0, "boom");
      expect((await row(a.id)).status).toBe("dead");
      const b = await enqueue(t.db, { ...base, runAt: minutes(60) });
      expect(b).toEqual({ id: a.id, created: false });
      expect((await row(a.id)).runAt).toEqual(T0);
    });
  });

  describe("claimNext", () => {
    it("returns nothing before run_at and the job at run_at exactly", async () => {
      const a = await enqueue(t.db, base);
      expect(
        await claimNext(t.db, new Date(T0.getTime() - 1), LEASE),
      ).toBeNull();
      const claimed = await claimNext(t.db, T0, LEASE);
      expect(claimed?.id).toBe(a.id);
    });

    it("marks the job running with a lease, one more attempt and started_at", async () => {
      await enqueue(t.db, base);
      const claimed = await claimNext(t.db, T0, LEASE);
      expect(claimed).toMatchObject({
        status: "running",
        attempts: 1,
        lockedUntil: new Date(T0.getTime() + LEASE),
        startedAt: T0,
      });
      expect(claimed?.runAt).toEqual(T0);
    });

    it("gives the job once, then null", async () => {
      await enqueue(t.db, base);
      expect(await claimNext(t.db, T0, LEASE)).not.toBeNull();
      expect(await claimNext(t.db, T0, LEASE)).toBeNull();
    });

    it("takes the earliest due job first", async () => {
      const late = await enqueue(t.db, {
        ...base,
        dedupeKey: "late",
        runAt: minutes(2),
      });
      const early = await enqueue(t.db, {
        ...base,
        dedupeKey: "early",
        runAt: minutes(1),
      });
      expect((await claimNext(t.db, minutes(5), LEASE))?.id).toBe(early.id);
      expect((await claimNext(t.db, minutes(5), LEASE))?.id).toBe(late.id);
    });

    it("does not take a running job until its lease has passed, then claims it again", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      expect(
        await claimNext(t.db, new Date(T0.getTime() + LEASE - 1), LEASE),
      ).toBeNull();
      const later = new Date(T0.getTime() + LEASE);
      const again = await claimNext(t.db, later, LEASE);
      expect(again?.id).toBe(a.id);
      expect(again?.attempts).toBe(2);
      expect(again?.lockedUntil).toEqual(new Date(later.getTime() + LEASE));
    });

    it("does not take succeeded or dead jobs", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      await completeId(a.id, T0);
      const b = await enqueue(t.db, {
        ...base,
        dedupeKey: "d",
        maxAttempts: 1,
      });
      await claimNext(t.db, T0, LEASE);
      await failId(b.id, T0, "boom");
      expect(await claimNext(t.db, minutes(1000), LEASE)).toBeNull();
    });

    it("takes a failed job once its backoff has passed", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      await failId(a.id, T0, "boom");
      expect(await claimNext(t.db, minutes(0.5), LEASE)).toBeNull();
      const again = await claimNext(t.db, minutes(1), LEASE);
      expect(again?.id).toBe(a.id);
      expect(again?.attempts).toBe(2);
    });
  });

  describe("complete", () => {
    it("sets succeeded, finished_at and clears the lease", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      await completeId(a.id, minutes(1));
      expect(await row(a.id)).toMatchObject({
        status: "succeeded",
        finishedAt: minutes(1),
        lockedUntil: null,
      });
    });
  });

  describe("fail", () => {
    it("sets failed with the error, clears the lease and backs off 1, 5 then 15 minutes", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 10 });
      const expected = [1, 5, 15, 15];
      let now = T0;
      for (const [i, delay] of expected.entries()) {
        const claimed = await claimNext(t.db, now, LEASE);
        expect(claimed?.attempts).toBe(i + 1);
        await failId(a.id, now, `boom ${i + 1}`);
        const r = await row(a.id);
        expect(r).toMatchObject({
          status: "failed",
          lastError: `boom ${i + 1}`,
          lockedUntil: null,
        });
        expect(r.runAt).toEqual(new Date(now.getTime() + delay * 60_000));
        now = r.runAt;
      }
    });

    it("ends dead after max_attempts failures", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 3 });
      let now = T0;
      for (let i = 1; i <= 3; i++) {
        const claimed = await claimNext(t.db, now, LEASE);
        expect(claimed?.id).toBe(a.id);
        await failId(a.id, now, `boom ${i}`);
        now = new Date(now.getTime() + 60 * 60_000);
      }
      const r = await row(a.id);
      expect(r).toMatchObject({
        status: "dead",
        attempts: 3,
        lastError: "boom 3",
        lockedUntil: null,
        finishedAt: new Date(now.getTime() - 60 * 60_000),
      });
      expect(await claimNext(t.db, now, LEASE)).toBeNull();
    });
  });
  describe("a dead job raises an alert", () => {
    const items = () => t.db.select().from(reviewItems);

    it("fail opens a warning job_dead item when the last attempt fails", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 2 });
      await claimNext(t.db, T0, LEASE);
      await failId(a.id, T0, "boom 1");
      expect(await items()).toEqual([]);

      await claimNext(t.db, minutes(1), LEASE);
      await failId(a.id, minutes(1), "boom 2");
      expect(await items()).toMatchObject([
        {
          kind: "job_dead",
          severity: "warning",
          status: "open",
          dedupeKey: `job_dead:${a.id}`,
          createdAt: minutes(1),
          details: {
            kind: "poll_session",
            dedupe_key: "poll:s1:1",
            attempts: 2,
            last_error: "boom 2",
          },
        },
      ]);
    });

    it("reapExpired opens one for each job it dead-letters, once", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 1 });
      await claimNext(t.db, T0, LEASE);
      const later = new Date(T0.getTime() + LEASE);
      expect(await reapExpired(t.db, later)).toBe(1);
      expect(await items()).toMatchObject([
        {
          kind: "job_dead",
          severity: "warning",
          dedupeKey: `job_dead:${a.id}`,
          createdAt: later,
          details: {
            kind: "poll_session",
            dedupe_key: "poll:s1:1",
            attempts: 1,
            last_error: "lease expired after max attempts",
          },
        },
      ]);
      expect(await reapExpired(t.db, later)).toBe(0);
      expect(await items()).toHaveLength(1);
    });

    it("a stale claim that cannot kill the job opens nothing", async () => {
      await enqueue(t.db, { ...base, maxAttempts: 1 });
      const first = (await claimNext(t.db, T0, LEASE))!;
      const stale = { ...first, attempts: first.attempts + 1 };
      expect(await fail(t.db, stale, T0, "stale")).toBe(false);
      expect(await items()).toEqual([]);
    });
  });

  describe("expired leases past max_attempts", () => {
    it("is not reclaimed past the limit and reapExpired dead-letters it", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 2 });
      const l1 = new Date(T0.getTime() + LEASE);
      const l2 = new Date(l1.getTime() + LEASE);
      expect((await claimNext(t.db, T0, LEASE))?.attempts).toBe(1);
      expect((await claimNext(t.db, l1, LEASE))?.attempts).toBe(2);
      expect(await claimNext(t.db, l2, LEASE)).toBeNull();
      expect((await row(a.id)).status).toBe("running");
      expect(await reapExpired(t.db, l2)).toBe(1);
      expect(await row(a.id)).toMatchObject({
        status: "dead",
        lastError: "lease expired after max attempts",
        lockedUntil: null,
        finishedAt: l2,
        attempts: 2,
      });
      expect(await reapExpired(t.db, l2)).toBe(0);
    });

    it("reapExpired leaves a live lease and an under-limit job alone", async () => {
      const live = await enqueue(t.db, {
        ...base,
        dedupeKey: "live",
        maxAttempts: 1,
      });
      await claimNext(t.db, T0, LEASE);
      expect(await reapExpired(t.db, new Date(T0.getTime() + LEASE - 1))).toBe(
        0,
      );
      expect((await row(live.id)).status).toBe("running");
      await t.db.delete(jobs);
      const under = await enqueue(t.db, {
        ...base,
        dedupeKey: "u",
        maxAttempts: 2,
      });
      await claimNext(t.db, T0, LEASE);
      expect(await reapExpired(t.db, new Date(T0.getTime() + LEASE))).toBe(0);
      expect((await row(under.id)).status).toBe("running");
    });

    it("an expired job at attempts = max - 1 is reclaimable once", async () => {
      const a = await enqueue(t.db, { ...base, maxAttempts: 3 });
      let now = T0;
      for (const attempts of [1, 2, 3]) {
        const c = await claimNext(t.db, now, LEASE);
        expect(c?.id).toBe(a.id);
        expect(c?.attempts).toBe(attempts);
        now = new Date(now.getTime() + LEASE);
      }
      expect(await claimNext(t.db, now, LEASE)).toBeNull();
    });
  });

  describe("fencing", () => {
    it("complete and fail with a stale claim return false and change nothing", async () => {
      const a = await enqueue(t.db, base);
      const first = (await claimNext(t.db, T0, LEASE))!;
      const later = new Date(T0.getTime() + LEASE);
      const second = (await claimNext(t.db, later, LEASE))!;
      expect(second.attempts).toBe(2);
      const before = await row(a.id);
      expect(await complete(t.db, first, later)).toBe(false);
      expect(await fail(t.db, first, later, "stale")).toBe(false);
      expect(await row(a.id)).toEqual(before);
      expect(await complete(t.db, second, later)).toBe(true);
      expect((await row(a.id)).status).toBe("succeeded");
    });

    it("fail on a succeeded row is a no-op", async () => {
      const a = await enqueue(t.db, base);
      const claimed = (await claimNext(t.db, T0, LEASE))!;
      expect(await complete(t.db, claimed, T0)).toBe(true);
      const before = await row(a.id);
      expect(await fail(t.db, claimed, minutes(1), "late")).toBe(false);
      expect(await complete(t.db, claimed, minutes(1))).toBe(false);
      expect(await row(a.id)).toEqual(before);
    });

    it("claims jobs with equal run_at in id order", async () => {
      const ids = [];
      for (const k of ["a", "b", "c"]) {
        ids.push((await enqueue(t.db, { ...base, dedupeKey: k })).id);
      }
      const got = [];
      for (let i = 0; i < 3; i++)
        got.push((await claimNext(t.db, T0, LEASE))?.id);
      expect(got).toEqual([...ids].sort());
    });
  });
});
