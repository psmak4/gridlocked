import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { jobs } from "@/db/schema";
import { claimNext, complete, enqueue, fail } from "./queue";

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
      await fail(t.db, a.id, T0, "boom");
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
      await complete(t.db, a.id, minutes(1));
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
      await fail(t.db, a.id, T0, "boom");
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
      await complete(t.db, a.id, T0);
      const b = await enqueue(t.db, {
        ...base,
        dedupeKey: "d",
        maxAttempts: 1,
      });
      await claimNext(t.db, T0, LEASE);
      await fail(t.db, b.id, T0, "boom");
      expect(await claimNext(t.db, minutes(1000), LEASE)).toBeNull();
    });

    it("takes a failed job once its backoff has passed", async () => {
      const a = await enqueue(t.db, base);
      await claimNext(t.db, T0, LEASE);
      await fail(t.db, a.id, T0, "boom");
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
      await complete(t.db, a.id, minutes(1));
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
        await fail(t.db, a.id, now, `boom ${i + 1}`);
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
        await fail(t.db, a.id, now, `boom ${i}`);
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
});
