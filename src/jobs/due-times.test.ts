import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { jobs } from "@/db/schema";
import {
  decideTick,
  DUE_KEY,
  nextDueFile,
  parseDueFile,
  publishDueTimes,
  republishIfEarlier,
  type DueFile,
} from "./due-times";
import { enqueue } from "./queue";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const file = (nextDueAt: string | null): string =>
  JSON.stringify({
    version: 1,
    generated_at: "2026-03-01T09:59:00.000Z",
    next_due_at: nextDueAt,
  } satisfies DueFile);

describe("parseDueFile", () => {
  it("parses a valid file", () => {
    expect(parseDueFile(file("2026-03-01T10:05:00.000Z"))).toEqual({
      ok: true,
      file: {
        version: 1,
        generated_at: "2026-03-01T09:59:00.000Z",
        next_due_at: "2026-03-01T10:05:00.000Z",
      },
    });
  });

  it("accepts a null next_due_at", () => {
    const parsed = parseDueFile(file(null));
    expect(parsed).toMatchObject({ ok: true, file: { next_due_at: null } });
  });

  it("reports a missing file", () => {
    expect(parseDueFile(null)).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["not json", "{nope"],
    ["not an object", "42"],
    ["null", "null"],
    [
      "wrong version",
      JSON.stringify({
        version: 2,
        generated_at: "2026-03-01T09:59:00Z",
        next_due_at: null,
      }),
    ],
    [
      "bad generated_at",
      JSON.stringify({
        version: 1,
        generated_at: "yesterday",
        next_due_at: null,
      }),
    ],
    [
      "missing next_due_at",
      JSON.stringify({ version: 1, generated_at: "2026-03-01T09:59:00Z" }),
    ],
    [
      "bad next_due_at",
      JSON.stringify({
        version: 1,
        generated_at: "2026-03-01T09:59:00Z",
        next_due_at: "soon",
      }),
    ],
    [
      "next_due_at without an offset",
      JSON.stringify({
        version: 1,
        generated_at: "2026-03-01T09:59:00Z",
        next_due_at: "2026-03-01T10:00:00",
      }),
    ],
  ])("reports malformed: %s", (_name, text) => {
    expect(parseDueFile(text)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("decideTick", () => {
  it("sleeps when next_due_at is null", () => {
    expect(decideTick(parseDueFile(file(null)), T0)).toEqual({
      action: "sleep",
    });
  });

  it("sleeps when next_due_at is in the future", () => {
    const next = at(1).toISOString();
    expect(decideTick(parseDueFile(file(next)), T0)).toEqual({
      action: "sleep",
    });
  });

  it("wakes when next_due_at is exactly now", () => {
    expect(decideTick(parseDueFile(file(T0.toISOString())), T0)).toEqual({
      action: "wake",
    });
  });

  it("wakes when next_due_at is in the past", () => {
    const next = at(-5).toISOString();
    expect(decideTick(parseDueFile(file(next)), T0)).toEqual({
      action: "wake",
    });
  });

  it("skips, and never wakes, when the file is missing", () => {
    expect(decideTick(parseDueFile(null), T0)).toEqual({
      action: "skip",
      reason: "missing",
    });
  });

  it("skips, and never wakes, when the file is malformed", () => {
    expect(decideTick(parseDueFile("{"), T0)).toEqual({
      action: "skip",
      reason: "malformed",
    });
  });
});

describe("nextDueFile", () => {
  it("takes the earliest time and stamps generated_at", () => {
    expect(nextDueFile([at(5), at(1), at(3)], T0)).toEqual({
      version: 1,
      generated_at: T0.toISOString(),
      next_due_at: at(1).toISOString(),
    });
  });

  it("has a null next_due_at when nothing is due", () => {
    expect(nextDueFile([], T0).next_due_at).toBeNull();
  });
});

describe("publishDueTimes and republishIfEarlier", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  async function seed(
    key: string,
    runAt: Date,
    patch: Partial<typeof jobs.$inferInsert> = {},
  ) {
    const { id } = await enqueue(t.db, {
      kind: "k",
      dedupeKey: key,
      runAt,
      payload: {},
    });
    if (Object.keys(patch).length > 0) {
      await t.db.update(jobs).set(patch).where(eq(jobs.id, id));
    }
    return id;
  }

  const published = (m: ReturnType<typeof createMemoryDueStore>) =>
    JSON.parse(m.objects.get(DUE_KEY)!) as DueFile;

  describe("publishDueTimes", () => {
    it("gives null when there are no jobs", async () => {
      const m = createMemoryDueStore();
      const result = await publishDueTimes(t.db, m.store, T0);
      expect(result).toEqual({
        version: 1,
        generated_at: T0.toISOString(),
        next_due_at: null,
      });
      expect(published(m)).toEqual(result);
    });

    it("uses the earliest run_at of pending jobs", async () => {
      await seed("a", at(30));
      await seed("b", at(10));
      await seed("c", at(20));
      const m = createMemoryDueStore();
      const result = await publishDueTimes(t.db, m.store, T0);
      expect(result.next_due_at).toBe(at(10).toISOString());
      expect(published(m).next_due_at).toBe(at(10).toISOString());
    });

    it("counts failed jobs at their retry time", async () => {
      await seed("a", at(30));
      await seed("b", at(5), { status: "failed", attempts: 1 });
      const result = await publishDueTimes(
        t.db,
        createMemoryDueStore().store,
        T0,
      );
      expect(result.next_due_at).toBe(at(5).toISOString());
    });

    it("counts a running job at its lease expiry, not its run_at", async () => {
      await seed("a", at(30));
      await seed("b", at(-60), {
        status: "running",
        attempts: 1,
        lockedUntil: at(8),
      });
      const result = await publishDueTimes(
        t.db,
        createMemoryDueStore().store,
        T0,
      );
      expect(result.next_due_at).toBe(at(8).toISOString());
    });

    it("counts a running job whose lease already expired", async () => {
      await seed("a", at(30));
      await seed("b", at(-60), {
        status: "running",
        attempts: 1,
        lockedUntil: at(-2),
      });
      const result = await publishDueTimes(
        t.db,
        createMemoryDueStore().store,
        T0,
      );
      expect(result.next_due_at).toBe(at(-2).toISOString());
    });

    it("ignores succeeded and dead jobs", async () => {
      await seed("a", at(-30), { status: "succeeded", finishedAt: at(-29) });
      await seed("b", at(-20), { status: "dead", finishedAt: at(-19) });
      await seed("c", at(40));
      const result = await publishDueTimes(
        t.db,
        createMemoryDueStore().store,
        T0,
      );
      expect(result.next_due_at).toBe(at(40).toISOString());
    });

    it("gives null when only finished jobs remain", async () => {
      await seed("a", at(-30), { status: "succeeded", finishedAt: at(-29) });
      await seed("b", at(-20), { status: "dead", finishedAt: at(-19) });
      const result = await publishDueTimes(
        t.db,
        createMemoryDueStore().store,
        T0,
      );
      expect(result.next_due_at).toBeNull();
    });

    it("overwrites an earlier file", async () => {
      const m = createMemoryDueStore({ [DUE_KEY]: file(at(1).toISOString()) });
      await publishDueTimes(t.db, m.store, T0);
      expect(published(m).next_due_at).toBeNull();
      expect(m.puts).toHaveLength(1);
    });
  });

  describe("republishIfEarlier", () => {
    it("writes when the new run_at is earlier than the stored one", async () => {
      await seed("a", at(5));
      const m = createMemoryDueStore({ [DUE_KEY]: file(at(30).toISOString()) });
      const wrote = await republishIfEarlier(t.db, m.store, T0, at(5));
      expect(wrote).toBe(true);
      expect(published(m)).toEqual({
        version: 1,
        generated_at: T0.toISOString(),
        next_due_at: at(5).toISOString(),
      });
    });

    it("writes when the stored file says nothing is due", async () => {
      await seed("a", at(5));
      const m = createMemoryDueStore({ [DUE_KEY]: file(null) });
      expect(await republishIfEarlier(t.db, m.store, T0, at(5))).toBe(true);
      expect(published(m).next_due_at).toBe(at(5).toISOString());
    });

    it("does not write when the new run_at is later", async () => {
      const stored = file(at(5).toISOString());
      const m = createMemoryDueStore({ [DUE_KEY]: stored });
      expect(await republishIfEarlier(t.db, m.store, T0, at(30))).toBe(false);
      expect(m.puts).toHaveLength(0);
      expect(m.objects.get(DUE_KEY)).toBe(stored);
    });

    it("does not write when the new run_at equals the stored one", async () => {
      const m = createMemoryDueStore({ [DUE_KEY]: file(at(5).toISOString()) });
      expect(await republishIfEarlier(t.db, m.store, T0, at(5))).toBe(false);
      expect(m.puts).toHaveLength(0);
    });

    it("rebuilds the file from the job table when it is missing", async () => {
      await seed("a", at(3));
      await seed("b", at(9));
      const m = createMemoryDueStore();
      expect(await republishIfEarlier(t.db, m.store, T0, at(9))).toBe(true);
      // The earliest job wins, not the run_at passed in.
      expect(published(m).next_due_at).toBe(at(3).toISOString());
    });

    it("rebuilds the file when it is malformed", async () => {
      await seed("a", at(3));
      const m = createMemoryDueStore({ [DUE_KEY]: "{broken" });
      expect(await republishIfEarlier(t.db, m.store, T0, at(9))).toBe(true);
      expect(published(m).next_due_at).toBe(at(3).toISOString());
    });
  });
});
