import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import {
  loadBody,
  rowsOf,
  seedResultsWorld,
  sessionIdFor,
  storeResultsSnapshot,
} from "../../../tests/helpers/results-2026";
import {
  providerIds,
  results,
  reviewItems,
  sessionResultState,
} from "@/db/schema";
import { normalizeJolpicaSession } from "./normalize-session";

describe("normalizeJolpicaSession", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const T1 = new Date("2026-03-08T07:00:00.000Z");
  const T2 = new Date("2026-03-08T09:30:00.000Z");

  beforeEach(async () => {
    t = await createTestDb();
    await seedResultsWorld(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  async function normalize(
    round: number,
    kind: "race" | "sprint" | "qualifying",
    body: unknown,
    now = T1,
  ) {
    const sessionId = await sessionIdFor(t.db, round, kind);
    const snapshotId = await storeResultsSnapshot(t.db, now, sessionId, body);
    const outcome = await normalizeJolpicaSession(
      t.db,
      now,
      sessionId,
      snapshotId,
      body,
    );
    return { sessionId, snapshotId, outcome };
  }

  const resultRows = (sessionId: string) =>
    t.db.select().from(results).where(eq(results.sessionId, sessionId));
  const reviews = (sessionId: string) =>
    t.db.select().from(reviewItems).where(eq(reviewItems.sessionId, sessionId));

  it("maps Jolpica keys to our ids and stores the race", async () => {
    const { sessionId } = await normalize(
      1,
      "race",
      loadBody("jolpica/2026/r01-results.json"),
    );
    expect(await resultRows(sessionId)).toHaveLength(22);
    expect(await reviews(sessionId)).toEqual([]);
  });

  it("reads the session's kind from the database, so a sprint uses SprintResults", async () => {
    const { sessionId } = await normalize(
      2,
      "sprint",
      loadBody("jolpica/2026/r02-sprint.json"),
    );
    const rows = await resultRows(sessionId);
    expect(rows).toHaveLength(22);
    expect(rows.every((r) => r.sessionKind === "sprint")).toBe(true);
  });

  async function unmap(providerKey: string) {
    await t.db
      .delete(providerIds)
      .where(eq(providerIds.providerKey, providerKey));
  }

  it("holds the session with a blocking item for an unmapped driver", async () => {
    await unmap("hulkenberg");
    const body = loadBody("jolpica/2026/r01-results.json");
    const { sessionId, outcome } = await normalize(1, "race", body);

    expect(outcome).toEqual({ changed: 0 });
    expect(await resultRows(sessionId)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId)),
    ).toEqual([]);
    const items = await reviews(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "unknown_driver",
      severity: "blocking",
      status: "open",
      dedupeKey: `unmapped:${sessionId}:jolpica:driver:hulkenberg`,
      createdAt: T1,
    });
    expect(items[0]!.details).toMatchObject({
      provider: "jolpica",
      key: "hulkenberg",
    });
  });

  it("opens no second item on a rerun, even with a new snapshot", async () => {
    await unmap("hulkenberg");
    const body = loadBody("jolpica/2026/r01-results.json");
    const { sessionId } = await normalize(1, "race", body);
    await normalize(1, "race", body, T2);
    rowsOf(body, "Results")[0]!.points = "26";
    await normalize(1, "race", body, T2);

    expect(await reviews(sessionId)).toHaveLength(1);
  });

  it("opens one item per unmapped constructor", async () => {
    await unmap("audi");
    const { sessionId, outcome } = await normalize(
      1,
      "race",
      loadBody("jolpica/2026/r01-results.json"),
    );

    expect(outcome).toEqual({ changed: 0 });
    expect(await resultRows(sessionId)).toEqual([]);
    const items = await reviews(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "unknown_constructor",
      severity: "blocking",
      dedupeKey: `unmapped:${sessionId}:jolpica:constructor:audi`,
    });
  });

  it("keeps the previous rows when a later response has an unmapped driver", async () => {
    const good = loadBody("jolpica/2026/r01-results.json");
    const { sessionId } = await normalize(1, "race", good);

    await unmap("russell");
    const later = loadBody("jolpica/2026/r01-results.json");
    rowsOf(later, "Results")[1]!.position = "5";
    await normalize(1, "race", later, T2);

    expect(await resultRows(sessionId)).toHaveLength(22);
    expect((await reviews(sessionId)).map((r) => r.kind)).toEqual([
      "unknown_driver",
    ]);
  });

  it("sends a parse failure through the normalizer's review item", async () => {
    const body = loadBody("jolpica/2026/r01-results.json");
    rowsOf(body, "Results")[0]!.positionText = "Z";
    const { sessionId, snapshotId } = await normalize(1, "race", body);

    const items = await reviews(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "unknown_classification",
      dedupeKey: `normalize:${sessionId}:${snapshotId}`,
    });
  });

  describe("a body that is not for this event", () => {
    it("holds the session when the body is for a different round, writing nothing", async () => {
      // Round 17's race, handed to round 18's race session.
      const { sessionId, snapshotId, outcome } = await normalize(
        18,
        "race",
        loadBody("jolpica/2026/r17-results.json"),
      );

      expect(outcome).toEqual({ changed: 0 });
      expect(await resultRows(sessionId)).toEqual([]);
      expect(
        await t.db
          .select()
          .from(sessionResultState)
          .where(eq(sessionResultState.sessionId, sessionId)),
      ).toEqual([]);
      const items = await reviews(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "validation_failed",
        severity: "blocking",
        status: "open",
        dedupeKey: `normalize:${sessionId}:${snapshotId}`,
        details: {
          snapshotId,
          asked: { season: 2026, round: 18, date: "2026-10-25" },
          got: { season: 2026, round: 17, date: "2026-10-11" },
        },
      });
    });

    it("keeps the rows it has when a later body is for another round", async () => {
      const { sessionId } = await normalize(
        18,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      await normalize(
        18,
        "race",
        loadBody("jolpica/2026/r17-results.json"),
        T2,
      );
      expect(await resultRows(sessionId)).toHaveLength(22);
      expect((await reviews(sessionId)).map((r) => r.kind)).toEqual([
        "validation_failed",
      ]);
    });

    it("holds the session when the body is dated 7 days off", async () => {
      const body = loadBody("jolpica/2026/r18-results.json");
      body.MRData.RaceTable.Races[0]!.date = "2026-11-01";
      const { sessionId } = await normalize(18, "race", body);

      expect(await resultRows(sessionId)).toEqual([]);
      const [item] = await reviews(sessionId);
      expect(item).toMatchObject({
        kind: "validation_failed",
        details: {
          asked: { season: 2026, round: 18, date: "2026-10-25" },
          got: { season: 2026, round: 18, date: "2026-11-01" },
        },
      });
    });

    it("accepts a date a day off (the race date is local, ours is UTC)", async () => {
      const body = loadBody("jolpica/2026/r18-results.json");
      body.MRData.RaceTable.Races[0]!.date = "2026-10-26";
      const { sessionId } = await normalize(18, "race", body);
      expect(await resultRows(sessionId)).toHaveLength(22);
      expect(await reviews(sessionId)).toEqual([]);
    });

    it("checks qualifying and the sprint against the same race", async () => {
      const wrong = loadBody("jolpica/2026/r18-qualifying.json");
      wrong.MRData.RaceTable.Races[0]!.round = "17";
      const { sessionId } = await normalize(18, "qualifying", wrong);
      expect(await resultRows(sessionId)).toEqual([]);
      expect((await reviews(sessionId)).map((r) => r.kind)).toEqual([
        "validation_failed",
      ]);
    });
  });
});
