import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { jobs } from "@/db/schema";
import { ClockModeError } from "@/lib/resolve-clock";
import { DUE_KEY, type DueFile } from "./due-times";
import { enqueue } from "./queue";
import type { JobHandler } from "./runner";
import { safetyTick, tick } from "./tick";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const file = (nextDueAt: string | null): string =>
  JSON.stringify({
    version: 1,
    generated_at: "2026-03-01T09:59:00.000Z",
    next_due_at: nextDueAt,
  } satisfies DueFile);

describe("tick", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  function setup(opts: { stored?: string; mode?: "system" | "replay" } = {}) {
    const m = createMemoryDueStore(
      opts.stored === undefined ? {} : { [DUE_KEY]: opts.stored },
    );
    const db = vi.fn(() => t.db);
    const seen: string[] = [];
    const handler: JobHandler = async (job) => {
      seen.push(job.dedupeKey);
    };
    const deps = {
      db,
      store: m.store,
      handlers: { k: handler },
      mode: opts.mode ?? ("system" as const),
    };
    return { m, db, seen, deps };
  }

  const job = (key: string, runAt: Date) =>
    enqueue(t.db, { kind: "k", dedupeKey: key, runAt, payload: {} });

  const published = (m: ReturnType<typeof createMemoryDueStore>) =>
    JSON.parse(m.objects.get(DUE_KEY)!) as DueFile;

  it("sleeps without touching the database when next_due_at is in the future", async () => {
    const { m, db, deps } = setup({ stored: file(at(5).toISOString()) });
    const result = await tick(deps, T0);
    expect(result).toEqual({ action: "sleep" });
    expect(db).not.toHaveBeenCalled();
    expect(m.puts).toHaveLength(0);
  });

  it("sleeps without touching the database when next_due_at is null", async () => {
    const { db, deps } = setup({ stored: file(null) });
    expect(await tick(deps, T0)).toEqual({ action: "sleep" });
    expect(db).not.toHaveBeenCalled();
  });

  it("republishes a missing file with one database wake, and runs no jobs that tick", async () => {
    await job("due-now", T0);
    await job("later", at(30));
    const { m, db, seen, deps } = setup();

    const result = await tick(deps, T0);

    expect(db).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      action: "republished",
      reason: "missing",
      file: {
        version: 1,
        generated_at: T0.toISOString(),
        // The job already due is in the file, so the next tick wakes and runs it.
        next_due_at: T0.toISOString(),
      },
    });
    expect(published(m)).toMatchObject({ next_due_at: T0.toISOString() });
    expect(m.puts).toHaveLength(1);
    expect(seen).toEqual([]);

    // The next minute reads a good file and runs the job.
    const next = await tick(deps, at(1));
    expect(next).toMatchObject({ action: "wake", run: { ran: 1 } });
    expect(seen).toEqual(["due-now"]);
  });

  it("republishes a malformed file the same way", async () => {
    await job("due-now", T0);
    const { m, db, seen, deps } = setup({ stored: "{" });

    const result = await tick(deps, T0);

    expect(db).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      action: "republished",
      reason: "malformed",
    });
    expect(published(m).next_due_at).toBe(T0.toISOString());
    expect(seen).toEqual([]);
  });

  it("republishes a missing file as null when nothing is due", async () => {
    const { m, deps } = setup();
    await tick(deps, T0);
    expect(published(m).next_due_at).toBeNull();
  });

  it("checks the clock mode before republishing a missing file", async () => {
    await t.client.query(
      "insert into settings (key, value) values ('simulated_clock', '\"2026-03-01T10:00:00Z\"'::jsonb)",
    );
    const { m, deps } = setup();
    await expect(tick(deps, T0)).rejects.toBeInstanceOf(ClockModeError);
    expect(m.puts).toHaveLength(0);
  });

  it("skips and logs, without touching the database, when the store cannot be read", async () => {
    const { db, deps } = setup();
    const log = vi.fn();
    const failing = {
      ...deps,
      log,
      store: {
        get: async () => {
          throw new Error("503 Service Unavailable");
        },
        put: vi.fn(async () => {}),
      },
    };

    const result = await tick(failing, T0);

    expect(result).toEqual({ action: "skip", reason: "store_unreadable" });
    expect(db).not.toHaveBeenCalled();
    expect(failing.store.put).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("503 Service Unavailable"),
    );
  });

  it("runs the due jobs on wake and republishes the file", async () => {
    await job("a", T0);
    await job("b", at(-3));
    await job("later", at(30));
    const { m, db, seen, deps } = setup({ stored: file(at(-3).toISOString()) });

    const result = await tick(deps, T0);

    expect(db).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      action: "wake",
      run: { ran: 2, failed: 0, lost: 0 },
    });
    expect(seen).toEqual(["b", "a"]);
    expect(published(m)).toEqual({
      version: 1,
      generated_at: T0.toISOString(),
      next_due_at: at(30).toISOString(),
    });
    expect(result).toMatchObject({ file: published(m) });
  });

  it("republishes null once nothing is left", async () => {
    await job("a", T0);
    const { m, deps } = setup({ stored: file(T0.toISOString()) });
    await tick(deps, T0);
    expect(published(m).next_due_at).toBeNull();
  });

  it("runs a burst of 20 jobs due in the same minute in one tick", async () => {
    for (let i = 0; i < 20; i++) await job(`burst-${i}`, at(0));
    const { m, db, seen, deps } = setup({ stored: file(T0.toISOString()) });

    const result = await tick(deps, T0);

    expect(db).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ action: "wake", run: { ran: 20 } });
    expect(seen).toHaveLength(20);
    expect(published(m).next_due_at).toBeNull();
  });

  it("runs at most maxJobs per tick and leaves the rest due", async () => {
    for (let i = 0; i < 20; i++) await job(`burst-${i}`, at(0));
    const { m, seen, deps } = setup({ stored: file(T0.toISOString()) });

    const result = await tick(deps, T0, { maxJobs: 5, leaseMs: 60_000 });

    expect(result).toMatchObject({ action: "wake", run: { ran: 5 } });
    expect(seen).toHaveLength(5);
    // 15 jobs are still due, so the file still says "wake".
    expect(published(m).next_due_at).toBe(T0.toISOString());
  });

  it("publishes the retry time of a job that failed", async () => {
    const { id } = await job("a", T0);
    const { m, deps } = setup({ stored: file(T0.toISOString()) });
    deps.handlers = {
      k: async () => {
        throw new Error("boom");
      },
    };
    const result = await tick(deps, T0);
    expect(result).toMatchObject({ run: { ran: 0, failed: 1 } });
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    expect(row!.status).toBe("failed");
    expect(published(m).next_due_at).toBe(row!.runAt.toISOString());
  });

  it("uses scheduledAt as the clock in system mode", async () => {
    await job("a", at(-1));
    let clockNow: Date | undefined;
    const { deps } = setup({ stored: file(at(-1).toISOString()) });
    deps.handlers = {
      k: async (_job, ctx) => {
        clockNow = ctx.clock.now();
      },
    };
    await tick(deps, T0);
    expect(clockNow).toEqual(T0);
  });

  it("throws ClockModeError on wake in system mode when simulated_clock is set, and runs nothing", async () => {
    await t.client.query(
      "insert into settings (key, value) values ('simulated_clock', '\"2026-03-01T10:00:00Z\"'::jsonb)",
    );
    const { id } = await job("a", T0);
    const { m, seen, deps } = setup({ stored: file(T0.toISOString()) });

    await expect(tick(deps, T0)).rejects.toBeInstanceOf(ClockModeError);

    expect(seen).toEqual([]);
    expect(m.puts).toHaveLength(0);
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    expect(row!.status).toBe("pending");
  });

  it("throws ClockModeError on wake in replay mode without simulated_clock", async () => {
    await job("a", T0);
    const { seen, deps } = setup({
      stored: file(T0.toISOString()),
      mode: "replay",
    });
    await expect(tick(deps, T0)).rejects.toBeInstanceOf(ClockModeError);
    expect(seen).toEqual([]);
  });
});

describe("safetyTick", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("republishes a missing file from the job table", async () => {
    await enqueue(t.db, {
      kind: "k",
      dedupeKey: "a",
      runAt: at(15),
      payload: {},
    });
    const m = createMemoryDueStore();
    const result = await safetyTick(
      { db: () => t.db, store: m.store, mode: "system" },
      T0,
    );
    expect(result).toEqual({
      version: 1,
      generated_at: T0.toISOString(),
      next_due_at: at(15).toISOString(),
    });
    expect(JSON.parse(m.objects.get(DUE_KEY)!)).toEqual(result);
  });

  it("dead-letters exhausted expired leases, then publishes", async () => {
    const { id } = await enqueue(t.db, {
      kind: "k",
      dedupeKey: "stuck",
      runAt: at(-60),
      payload: {},
      maxAttempts: 1,
    });
    await t.db
      .update(jobs)
      .set({ status: "running", attempts: 1, lockedUntil: at(-5) })
      .where(eq(jobs.id, id));
    const m = createMemoryDueStore({ [DUE_KEY]: file(at(-5).toISOString()) });

    const result = await safetyTick(
      { db: () => t.db, store: m.store, mode: "system" },
      T0,
    );

    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    expect(row!.status).toBe("dead");
    expect(result.next_due_at).toBeNull();
  });

  it("throws ClockModeError and publishes nothing on a clock-mode mismatch", async () => {
    await t.client.query(
      "insert into settings (key, value) values ('simulated_clock', '\"2026-03-01T10:00:00Z\"'::jsonb)",
    );
    const m = createMemoryDueStore();
    await expect(
      safetyTick({ db: () => t.db, store: m.store, mode: "system" }, T0),
    ).rejects.toBeInstanceOf(ClockModeError);
    expect(m.puts).toHaveLength(0);
  });
});
