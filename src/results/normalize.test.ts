import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  loadBody,
  parsedFor,
  rowsOf,
  seedResultsWorld,
  sessionIdFor,
  storeResultsSnapshot,
} from "../../tests/helpers/results-2026";
import {
  drivers,
  resultChanges,
  results,
  reviewItems,
  sessionResultState,
} from "@/db/schema";
import { normalizeSession } from "./normalize";
import type { ParsedResults } from "./types";

describe("normalizeSession", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const T1 = new Date("2026-03-08T07:00:00.000Z");
  const T2 = new Date("2026-03-08T09:30:00.000Z");
  const T3 = new Date("2026-03-09T09:30:00.000Z");

  beforeEach(async () => {
    t = await createTestDb();
    await seedResultsWorld(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  /** Stores `body` as a snapshot, parses it and normalizes it. */
  async function run(
    sessionId: string,
    kind: "race" | "qualifying" | "sprint",
    body: unknown,
    now: Date,
  ) {
    const snapshotId = await storeResultsSnapshot(t.db, now, sessionId, body);
    const parsed = await parsedFor(t.db, kind, body);
    const outcome = await normalizeSession(
      t.db,
      now,
      sessionId,
      snapshotId,
      parsed,
    );
    return { snapshotId, outcome };
  }

  const stored = (sessionId: string) =>
    t.db
      .select({
        slug: drivers.slug,
        row: results,
      })
      .from(results)
      .innerJoin(drivers, eq(drivers.id, results.driverId))
      .where(eq(results.sessionId, sessionId))
      .orderBy(asc(results.position));
  const changes = (sessionId: string) =>
    t.db
      .select({
        slug: drivers.slug,
        change: resultChanges,
      })
      .from(resultChanges)
      .innerJoin(drivers, eq(drivers.id, resultChanges.driverId))
      .where(eq(resultChanges.sessionId, sessionId))
      .orderBy(asc(resultChanges.field), asc(drivers.slug));
  const reviews = (sessionId: string) =>
    t.db.select().from(reviewItems).where(eq(reviewItems.sessionId, sessionId));
  const state = async (sessionId: string) =>
    (
      await t.db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0];

  describe("a first normalization", () => {
    it("stores every row, creates the state row and logs no changes", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const body = loadBody("jolpica/2026/r01-results.json");
      const { snapshotId, outcome } = await run(sessionId, "race", body, T1);

      expect(outcome).toEqual({ changed: 0 });
      const rows = await stored(sessionId);
      expect(rows).toHaveLength(22);
      expect(rows[0]!.slug).toBe("russell");
      expect(rows[0]!.row).toMatchObject({
        snapshotId,
        sessionKind: "race",
        classification: "classified",
        timeMs: 4986801,
        officialPoints: "25.0",
      });
      expect(await changes(sessionId)).toEqual([]);
      expect(await state(sessionId)).toMatchObject({
        status: "awaiting",
        source: "provider",
        currentSnapshotId: snapshotId,
      });
    });

    it("stores a race did-not-start and a pit-lane start", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const body = loadBody("jolpica/2026/r01-results.json");
      rowsOf(body, "Results")[3]!.grid = "0";
      await run(sessionId, "race", body, T1);

      const rows = await stored(sessionId);
      const pit = rows.find((r) => r.row.position === 4)!;
      expect(pit.row.pitLaneStart).toBe(true);
      expect(pit.row.grid).toBeNull();
      expect(
        rows.filter((r) => r.row.classification === "did_not_start"),
      ).toHaveLength(2);
    });

    it("stores qualifying, with a missing Q3 time as null", async () => {
      const sessionId = await sessionIdFor(t.db, 18, "qualifying");
      const body = loadBody("jolpica/2026/r18-qualifying.json");
      await run(sessionId, "qualifying", body, T1);

      const rows = await stored(sessionId);
      expect(rows).toHaveLength(22);
      const tenth = rows.find((r) => r.row.position === 10)!;
      expect(tenth.slug).toBe("lawson");
      expect(tenth.row.q3Ms).toBeNull();
      expect(tenth.row.q2Ms).toBe(95058);
      expect(tenth.row.sessionKind).toBe("qualifying");
    });

    it("writes nothing for an empty body, then logs no changes when the results arrive", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const empty = loadBody("jolpica/2026/r01-results.json");
      empty.MRData.RaceTable.Races[0]!.Results = [];
      const first = await run(sessionId, "race", empty, T1);

      expect(first.outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toEqual([]);
      expect((await state(sessionId))?.currentSnapshotId ?? null).toBeNull();
      expect(await reviews(sessionId)).toEqual([]);

      const real = await run(
        sessionId,
        "race",
        loadBody("jolpica/2026/r01-results.json"),
        T2,
      );
      expect(real.outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toHaveLength(22);
      expect(await changes(sessionId)).toEqual([]);
      expect((await state(sessionId))!.currentSnapshotId).toBe(real.snapshotId);
    });
  });

  describe("normalizing again", () => {
    it("changes nothing for the same snapshot", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const body = loadBody("jolpica/2026/r01-results.json");
      const { snapshotId } = await run(sessionId, "race", body, T1);
      const before = await stored(sessionId);

      const outcome = await normalizeSession(
        t.db,
        T2,
        sessionId,
        snapshotId,
        await parsedFor(t.db, "race", body),
      );

      expect(outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toEqual(before);
      expect(await changes(sessionId)).toEqual([]);
    });

    it("logs one change per driver when two positions swap", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const first = loadBody("jolpica/2026/r01-results.json");
      const a = await run(sessionId, "race", first, T1);

      const second = loadBody("jolpica/2026/r01-results.json");
      const rows = rowsOf(second, "Results");
      rows[5]!.position = "8";
      rows[7]!.position = "6";
      const b = await run(sessionId, "race", second, T2);

      expect(b.outcome).toEqual({ changed: 2 });
      const log = await changes(sessionId);
      expect(log).toHaveLength(2);
      for (const { change } of log) {
        expect(change).toMatchObject({
          field: "position",
          fromSnapshotId: a.snapshotId,
          toSnapshotId: b.snapshotId,
          detectedAt: T2,
        });
      }
      expect(
        log.map((l) => [l.change.oldValue, l.change.newValue]).sort(),
      ).toEqual([
        ["6", "8"],
        ["8", "6"],
      ]);
      expect(await state(sessionId)).toMatchObject({
        currentSnapshotId: b.snapshotId,
      });
      const after = await stored(sessionId);
      expect(after).toHaveLength(22);
      expect(after.every((r) => r.row.snapshotId === b.snapshotId)).toBe(true);
    });

    it("logs a stewards' penalty as a change per field that moved", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      await run(
        sessionId,
        "race",
        loadBody("jolpica/2026/r01-results.json"),
        T1,
      );

      const second = loadBody("jolpica/2026/r01-results.json");
      Object.assign(rowsOf(second, "Results")[0]!, {
        position: "2",
        points: "18",
        Time: { millis: "4991801", time: "1:23:11.801" },
      });
      const { outcome } = await run(sessionId, "race", second, T2);

      expect(outcome).toEqual({ changed: 3 });
      const log = await changes(sessionId);
      expect(
        log.map((l) => [l.change.field, l.change.oldValue, l.change.newValue]),
      ).toEqual([
        ["official_points", "25.0", "18.0"],
        ["position", "1", "2"],
        ["time_ms", "4986801", "4991801"],
      ]);
    });

    it("logs a driver that appears (staged publication) as a row change", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const partial = loadBody("jolpica/2026/r01-results.json");
      rowsOf(partial, "Results").pop();
      await run(sessionId, "race", partial, T1);
      expect(await stored(sessionId)).toHaveLength(21);

      const full = await run(
        sessionId,
        "race",
        loadBody("jolpica/2026/r01-results.json"),
        T2,
      );

      expect(full.outcome).toEqual({ changed: 1 });
      const log = await changes(sessionId);
      expect(log).toHaveLength(1);
      expect(log[0]!.change).toMatchObject({
        field: "row",
        oldValue: "absent",
        newValue: "present",
      });
      expect(await stored(sessionId)).toHaveLength(22);
    });

    it("uses the snapshot it is given when a refetch reverts to older content", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const first = loadBody("jolpica/2026/r01-results.json");
      const a = await run(sessionId, "race", first, T1);

      const second = loadBody("jolpica/2026/r01-results.json");
      rowsOf(second, "Results")[0]!.position = "2";
      const b = await run(sessionId, "race", second, T2);
      expect(b.snapshotId).not.toBe(a.snapshotId);

      // The provider goes back to its first answer: the same snapshot row.
      const c = await run(sessionId, "race", first, T3);
      expect(c.snapshotId).toBe(a.snapshotId);
      expect(c.outcome).toEqual({ changed: 1 });
      expect(await state(sessionId)).toMatchObject({
        currentSnapshotId: a.snapshotId,
      });
      const log = await changes(sessionId);
      const last = log.find((l) => l.change.toSnapshotId === a.snapshotId)!;
      expect(last.change).toMatchObject({
        fromSnapshotId: b.snapshotId,
        oldValue: "2",
        newValue: "1",
      });
    });
  });

  describe("results that disappear", () => {
    async function seeded() {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const a = await run(
        sessionId,
        "race",
        loadBody("jolpica/2026/r01-results.json"),
        T1,
      );
      return { sessionId, a, before: await stored(sessionId) };
    }

    it("holds an empty body over existing results behind a blocking item", async () => {
      const { sessionId, a, before } = await seeded();

      const empty = loadBody("jolpica/2026/r01-results.json");
      empty.MRData.RaceTable.Races[0]!.Results = [];
      const b = await run(sessionId, "race", empty, T2);

      expect(b.outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toEqual(before);
      expect(await changes(sessionId)).toEqual([]);
      expect((await state(sessionId))!.currentSnapshotId).toBe(a.snapshotId);
      const items = await reviews(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "results_disappeared",
        severity: "blocking",
        status: "open",
        dedupeKey: `normalize:${sessionId}:${b.snapshotId}`,
        createdAt: T2,
      });
      const details = items[0]!.details as {
        missingDriverIds: string[];
      };
      expect(details).toMatchObject({
        snapshotId: b.snapshotId,
        previousSnapshotId: a.snapshotId,
        previousRows: 22,
      });
      expect(new Set(details.missingDriverIds)).toEqual(
        new Set(before.map((r) => r.row.driverId)),
      );
    });

    it("holds a body that drops one driver", async () => {
      const { sessionId, a, before } = await seeded();

      const partial = loadBody("jolpica/2026/r01-results.json");
      rowsOf(partial, "Results").pop();
      const b = await run(sessionId, "race", partial, T2);

      expect(b.outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toEqual(before);
      expect(await changes(sessionId)).toEqual([]);
      expect((await state(sessionId))!.currentSnapshotId).toBe(a.snapshotId);
      const items = await reviews(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "results_disappeared",
        severity: "blocking",
      });
      expect(
        (items[0]!.details as { missingDriverIds: string[] }).missingDriverIds,
      ).toEqual([before.find((r) => r.row.position === 22)!.row.driverId]);
    });

    it("opens no second item when the same snapshot is run again", async () => {
      const { sessionId } = await seeded();
      const empty = loadBody("jolpica/2026/r01-results.json");
      empty.MRData.RaceTable.Races[0]!.Results = [];
      await run(sessionId, "race", empty, T2);
      await run(sessionId, "race", empty, T3);

      expect(await reviews(sessionId)).toHaveLength(1);
    });
  });

  describe("a response we cannot use (Review Focus 1)", () => {
    async function seeded() {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const good = loadBody("jolpica/2026/r01-results.json");
      const a = await run(sessionId, "race", good, T1);
      return { sessionId, a, good };
    }

    it("writes no rows and opens one blocking review item for an unknown positionText", async () => {
      const { sessionId, a } = await seeded();
      const before = await stored(sessionId);

      const bad = loadBody("jolpica/2026/r01-results.json");
      rowsOf(bad, "Results")[5]!.positionText = "Z";
      const b = await run(sessionId, "race", bad, T2);

      expect(b.outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toEqual(before);
      expect(await changes(sessionId)).toEqual([]);
      expect((await state(sessionId))!.currentSnapshotId).toBe(a.snapshotId);

      const items = await reviews(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "unknown_classification",
        severity: "blocking",
        status: "open",
        dedupeKey: `normalize:${sessionId}:${b.snapshotId}`,
        createdAt: T2,
      });
      expect(items[0]!.details).toMatchObject({
        problem: expect.stringContaining('unknown positionText "Z"'),
        snapshotId: b.snapshotId,
      });
    });

    it("opens no second item when the same bad snapshot is run again", async () => {
      const { sessionId } = await seeded();
      const bad = loadBody("jolpica/2026/r01-results.json");
      rowsOf(bad, "Results")[5]!.positionText = "Z";
      await run(sessionId, "race", bad, T2);
      await run(sessionId, "race", bad, T3);

      expect(await reviews(sessionId)).toHaveLength(1);
    });

    it("treats a body with no Results the same way, as validation_failed", async () => {
      const { sessionId, a } = await seeded();
      const before = await stored(sessionId);

      const bad = loadBody("jolpica/2026/r01-results.json");
      delete bad.MRData.RaceTable.Races[0]!.Results;
      const b = await run(sessionId, "race", bad, T2);
      await run(sessionId, "race", bad, T3);

      expect(await stored(sessionId)).toEqual(before);
      expect((await state(sessionId))!.currentSnapshotId).toBe(a.snapshotId);
      const items = await reviews(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "validation_failed",
        severity: "blocking",
        dedupeKey: `normalize:${sessionId}:${b.snapshotId}`,
      });
      expect(items[0]!.details).toMatchObject({ problem: "missing results" });
    });

    it("creates no state row for a first response that fails", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const bad = loadBody("jolpica/2026/r01-results.json");
      delete bad.MRData.RaceTable.Races[0]!.Results;
      await run(sessionId, "race", bad, T1);

      expect(await state(sessionId)).toBeUndefined();
      expect(await stored(sessionId)).toEqual([]);
      expect(await reviews(sessionId)).toHaveLength(1);
    });

    it("links the item to the session's event and season", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const failed: ParsedResults = {
        ok: false,
        problem: "boom",
        code: "validation_failed",
      };
      const snapshotId = await storeResultsSnapshot(t.db, T1, sessionId, {});
      await normalizeSession(t.db, T1, sessionId, snapshotId, failed);

      const [item] = await t.db
        .select()
        .from(reviewItems)
        .where(and(eq(reviewItems.sessionId, sessionId)));
      expect(item!.seasonId).not.toBeNull();
      expect(item!.eventId).not.toBeNull();
    });
  });

  describe("a final session", () => {
    it("is never written to: the response is refused with a warning", async () => {
      const sessionId = await sessionIdFor(t.db, 1, "race");
      const first = await run(
        sessionId,
        "race",
        loadBody("jolpica/2026/r01-results.json"),
        T1,
      );
      await t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: T1 })
        .where(eq(sessionResultState.sessionId, sessionId));
      const before = await stored(sessionId);

      const late = loadBody("jolpica/2026/r01-results.json");
      const [a, b] = rowsOf(late, "Results");
      for (const key of ["position", "positionText"]) {
        [a![key], b![key]] = [b![key], a![key]];
      }
      const second = await run(sessionId, "race", late, T2);

      expect(second.outcome).toEqual({ changed: 0 });
      expect(await stored(sessionId)).toEqual(before);
      expect(await changes(sessionId)).toEqual([]);
      expect((await state(sessionId))!.currentSnapshotId).toBe(
        first.snapshotId,
      );
      const items = await reviews(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "normalize_after_final",
        severity: "warning",
        status: "open",
        dedupeKey: `normalize_after_final:${sessionId}:${second.snapshotId}`,
      });

      // The same snapshot again does not pile up a second warning.
      await normalizeSession(
        t.db,
        T3,
        sessionId,
        second.snapshotId,
        await parsedFor(t.db, "race", late),
      );
      expect(await reviews(sessionId)).toHaveLength(1);
    });
  });
});
