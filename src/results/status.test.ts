import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  idFor,
  ingest,
  ingestRecorded,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import {
  loadBody,
  parsedFor,
  rowsOf,
  sessionIdFor,
} from "../../tests/helpers/results-2026";
import {
  effectiveResults,
  resultOverrides,
  results,
  reviewItems,
  sessionResultState,
} from "@/db/schema";
import { openReviewItem } from "@/reference/review";
import { getSessionContext } from "./session-context";
import { addOverride, revokeOverride } from "./overrides";
import { advanceStatus } from "./status";

describe("advanceStatus", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const T0 = new Date("2026-10-04T08:00:00.000Z");
  const T1 = new Date("2026-10-04T09:00:00.000Z");
  const T2 = new Date("2026-10-04T10:00:00.000Z");
  const T3 = new Date("2026-10-04T11:00:00.000Z");
  const ADMIN = "0198f3e0-0000-7000-8000-0000000000aa";

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  const state = async (sessionId: string) =>
    (
      await t.db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0];
  const items = (sessionId: string) =>
    t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.sessionId, sessionId))
      .orderBy(asc(reviewItems.createdAt), asc(reviewItems.dedupeKey));

  /** A round 18 race whose Russell row is in `constructorKey`'s car. */
  async function raceWithRussellIn(constructorKey: string) {
    const id = await sessionIdFor(t.db, 18, "race");
    await seedEntriesFor(t.db, id);
    const body = loadBody("jolpica/2026/r18-results.json");
    const row = rowsOf(body, "Results").find(
      (r) => (r.Driver as { driverId: string }).driverId === "russell",
    )!;
    (row.Constructor as { constructorId: string }).constructorId =
      constructorKey;
    await ingest(t.db, T0, id, "race", body);
    return id;
  }

  describe("a complete, clean session", () => {
    it("moves awaiting to provisional, and creates the state row if needed", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      expect((await state(id))!.status).toBe("awaiting");

      expect(await advanceStatus(t.db, T1, id)).toBe("provisional");
      expect(await state(id)).toMatchObject({
        status: "provisional",
        version: 3,
      });
      expect(await items(id)).toEqual([]);
    });

    it("does nothing the second time", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await advanceStatus(t.db, T1, id);
      const before = await state(id);
      expect(await advanceStatus(t.db, T2, id)).toBe("provisional");
      expect(await state(id)).toEqual(before);
    });

    it("moves a qualifying session too", async () => {
      const id = await ingestRecorded(
        t.db,
        T0,
        18,
        "qualifying",
        "r18-qualifying.json",
      );
      expect(await advanceStatus(t.db, T1, id)).toBe("provisional");
    });

    it("leaves a final session alone", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: T1 })
        .where(eq(sessionResultState.sessionId, id));
      await patchOverride(id, "russell", { constructor_id: await ferrari() });
      expect(await advanceStatus(t.db, T2, id)).toBe("final");
      expect(await items(id)).toEqual([]);
    });

    async function ferrari() {
      return idFor(t.db, "constructor", "ferrari");
    }
    async function patchOverride(
      sessionId: string,
      driver: string,
      fields: Parameters<typeof addOverride>[2]["fields"],
    ) {
      return addOverride(t.db, T1, {
        sessionId,
        driverId: await idFor(t.db, "driver", driver),
        kind: "patch",
        fields,
        reason: "test",
        createdBy: ADMIN,
      });
    }
  });

  describe("an incomplete session", () => {
    it("with no results yet stays awaiting and opens nothing", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      expect(await advanceStatus(t.db, T1, id)).toBe("awaiting");
      expect(await state(id)).toMatchObject({
        status: "awaiting",
        source: "provider",
      });
      expect(await items(id)).toEqual([]);
    });

    it("with one row removed stays awaiting, and completes when it is back", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const russell = await idFor(t.db, "driver", "russell");
      const suppress = await addOverride(t.db, T1, {
        sessionId: id,
        driverId: russell,
        kind: "suppress",
        reason: "drop one",
        createdBy: ADMIN,
      });
      expect(await advanceStatus(t.db, T1, id)).toBe("awaiting");
      expect(await items(id)).toEqual([]);

      await revokeOverride(t.db, T2, suppress, ADMIN);
      expect(await advanceStatus(t.db, T2, id)).toBe("provisional");
    });

    it("a provisional session that loses a row goes back to awaiting", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await advanceStatus(t.db, T1, id);
      await addOverride(t.db, T2, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "suppress",
        reason: "drop one",
        createdBy: ADMIN,
      });
      expect(await advanceStatus(t.db, T2, id)).toBe("awaiting");
    });
  });

  describe("a roster surprise", () => {
    it("opens a blocking team_change and moves to under_review", async () => {
      const id = await raceWithRussellIn("ferrari");
      expect(await advanceStatus(t.db, T1, id)).toBe("under_review");

      const open = (await items(id)).filter((i) => i.status === "open");
      const russell = await idFor(t.db, "driver", "russell");
      const team = open.find((i) => i.kind === "team_change")!;
      expect(team).toMatchObject({
        severity: "blocking",
        driverId: russell,
        dedupeKey: `validate:${id}:team_change:${russell}`,
        createdAt: T1,
      });
      expect(team.details).toMatchObject({ problem: "team_change" });
      const ctx = await getSessionContext(t.db, id);
      expect(team).toMatchObject({
        eventId: ctx.eventId,
        seasonId: ctx.seasonId,
      });
    });

    it("a repeated check does not pile up items", async () => {
      const id = await raceWithRussellIn("ferrari");
      await advanceStatus(t.db, T1, id);
      const first = await items(id);
      await advanceStatus(t.db, T2, id);
      await advanceStatus(t.db, T3, id);
      expect(await items(id)).toEqual(first);
    });

    it("resolving the item and advancing again moves it to provisional", async () => {
      const id = await raceWithRussellIn("ferrari");
      await advanceStatus(t.db, T1, id);
      await t.db
        .update(reviewItems)
        .set({
          status: "resolved",
          resolution: "accepted: Russell drove the Ferrari",
          resolvedBy: ADMIN,
          resolvedAt: T2,
        })
        .where(
          and(eq(reviewItems.sessionId, id), eq(reviewItems.status, "open")),
        );

      expect(await advanceStatus(t.db, T2, id)).toBe("provisional");
      // The decided findings were not reopened.
      expect((await items(id)).every((i) => i.status === "resolved")).toBe(
        true,
      );
      expect(await advanceStatus(t.db, T3, id)).toBe("provisional");
    });

    it("a finding the admin dismissed is not reopened, but a changed finding is", async () => {
      const id = await raceWithRussellIn("ferrari");
      await advanceStatus(t.db, T1, id);
      await t.db
        .update(reviewItems)
        .set({ status: "dismissed", resolution: "ignore", resolvedAt: T2 })
        .where(eq(reviewItems.sessionId, id));
      expect(await advanceStatus(t.db, T2, id)).toBe("provisional");

      // The car number changes: not the thing the admin decided on.
      await addOverride(t.db, T2, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "patch",
        fields: { car_number: 99 },
        reason: "test",
        createdBy: ADMIN,
      });
      expect(await advanceStatus(t.db, T3, id)).toBe("under_review");
    });

    it("refreshes the details of an item that is still open", async () => {
      const id = await raceWithRussellIn("ferrari");
      await advanceStatus(t.db, T1, id);
      const [before] = (await items(id)).filter(
        (i) => i.kind === "team_change",
      );

      await addOverride(t.db, T2, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "patch",
        fields: { car_number: 99 },
        reason: "test",
        createdBy: ADMIN,
      });
      expect(await advanceStatus(t.db, T3, id)).toBe("under_review");
      const [after] = (await items(id)).filter((i) => i.kind === "team_change");
      expect(after!.id).toBe(before!.id);
      expect(after!.status).toBe("open");
      expect(after!.details).toMatchObject({ carNumber: 99 });
    });

    it("resolves a finding that is no longer detected, so a fixed session advances", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      await ingest(
        t.db,
        T0,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      const bad = await addOverride(t.db, T1, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "patch",
        fields: { constructor_id: await idFor(t.db, "constructor", "ferrari") },
        reason: "wrong car",
        createdBy: ADMIN,
      });
      expect(await advanceStatus(t.db, T1, id)).toBe("under_review");

      await revokeOverride(t.db, T2, bad, ADMIN);
      expect(await advanceStatus(t.db, T2, id)).toBe("provisional");
      const all = await items(id);
      expect(all.length).toBeGreaterThan(0);
      for (const item of all) {
        expect(item).toMatchObject({
          status: "resolved",
          resolution: "auto: no longer detected",
          resolvedAt: T2,
        });
      }

      // If it comes back it is a new finding, and holds the session again.
      await addOverride(t.db, T3, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "patch",
        fields: { constructor_id: await idFor(t.db, "constructor", "ferrari") },
        reason: "wrong car again",
        createdBy: ADMIN,
      });
      expect(await advanceStatus(t.db, T3, id)).toBe("under_review");
      expect(
        (await items(id)).filter((i) => i.status === "open"),
      ).not.toHaveLength(0);
    });

    it("another open blocking item holds the session without tripping the guard", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const ctx = await getSessionContext(t.db, id);
      await openReviewItem(t.db, T0, {
        kind: "results_disappeared",
        severity: "blocking",
        seasonId: ctx.seasonId,
        eventId: ctx.eventId,
        sessionId: id,
        details: {},
        dedupeKey: `normalize:${id}:x`,
      });
      expect(await advanceStatus(t.db, T1, id)).toBe("under_review");
      // It is not one of ours, so it is left alone.
      const [item] = await items(id);
      expect(item).toMatchObject({
        status: "open",
        kind: "results_disappeared",
      });
    });

    it("a warning item does not hold the session", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const ctx = await getSessionContext(t.db, id);
      await openReviewItem(t.db, T0, {
        kind: "provider_mismatch",
        seasonId: ctx.seasonId,
        sessionId: id,
        details: {},
        dedupeKey: `warn:${id}`,
      });
      expect(await advanceStatus(t.db, T1, id)).toBe("provisional");
    });

    it("under_review goes to provisional once the problem and the items are gone", async () => {
      const id = await raceWithRussellIn("ferrari");
      expect(await advanceStatus(t.db, T1, id)).toBe("under_review");
      // A corrected provider response.
      await ingest(
        t.db,
        T2,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      expect(await advanceStatus(t.db, T2, id)).toBe("provisional");
    });
  });

  it("refuses a session that has no results to validate", async () => {
    const id = await sessionIdFor(t.db, 18, "fp1");
    await expect(advanceStatus(t.db, T1, id)).rejects.toThrow(/fp1/);
  });

  describe("provider data after a manual entry (DM 2.6)", () => {
    /** Every driver of the recorded race, entered by hand. */
    async function enterByHand(sessionId: string) {
      await t.db
        .insert(sessionResultState)
        .values({ sessionId, source: "manual" });
      const parsed = await parsedFor(
        t.db,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      if (!parsed.ok) throw new Error(parsed.problem);
      for (const { driverId, constructorId, ...facts } of parsed.rows) {
        await addOverride(t.db, T0, {
          sessionId,
          driverId,
          kind: "insert",
          fields: {
            constructor_id: constructorId,
            car_number: facts.carNumber,
            position: facts.position,
            classification: facts.classification,
            provider_status: facts.providerStatus,
            provider_position_text: facts.providerPositionText,
            grid: facts.grid,
            pit_lane_start: facts.pitLaneStart,
            laps: facts.laps,
            time_ms: facts.timeMs,
            fastest_lap_rank: facts.fastestLapRank,
            fastest_lap_ms: facts.fastestLapMs,
            official_points: facts.officialPoints,
          },
          reason: "provider down: entered from the broadcast",
          createdBy: ADMIN,
        });
      }
    }
    const activeInserts = (sessionId: string) =>
      t.db
        .select()
        .from(resultOverrides)
        .where(
          and(
            eq(resultOverrides.sessionId, sessionId),
            eq(resultOverrides.kind, "insert"),
          ),
        );

    it("a hand-entered session is validated like any other", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      await enterByHand(id);
      expect(await advanceStatus(t.db, T1, id)).toBe("provisional");
    });

    it("opens provider_after_manual, keeps the inserts, and holds the session", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      await enterByHand(id);
      await advanceStatus(t.db, T1, id);

      const snapshotId = await ingest(
        t.db,
        T2,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      expect(await advanceStatus(t.db, T2, id)).toBe("under_review");

      const [item] = await items(id);
      expect(item).toMatchObject({
        kind: "provider_after_manual",
        severity: "blocking",
        status: "open",
        dedupeKey: `provider_after_manual:${id}:${snapshotId}`,
        createdAt: T2,
      });
      expect(item!.details).toMatchObject({ snapshotId });
      // The provider rows are stored, and the manual rows are still the ones in effect.
      expect(
        await t.db.select().from(results).where(eq(results.sessionId, id)),
      ).toHaveLength(22);
      const inserts = await activeInserts(id);
      expect(inserts).toHaveLength(22);
      expect(inserts.every((o) => o.revokedAt === null)).toBe(true);
      const effective = await t.db
        .select()
        .from(effectiveResults)
        .where(eq(effectiveResults.sessionId, id));
      expect(effective).toHaveLength(22);
      expect(
        effective.every((r) => r.overridden && r.snapshotId === null),
      ).toBe(true);
      expect((await state(id))!.source).toBe("manual");
    });

    it("stays held until an admin decides, then does not reopen for that snapshot", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      await enterByHand(id);
      await ingest(
        t.db,
        T1,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      expect(await advanceStatus(t.db, T1, id)).toBe("under_review");
      expect(await advanceStatus(t.db, T2, id)).toBe("under_review");
      expect(await items(id)).toHaveLength(1);

      await t.db
        .update(reviewItems)
        .set({
          status: "resolved",
          resolution: "keep the manual rows",
          resolvedBy: ADMIN,
          resolvedAt: T2,
        })
        .where(eq(reviewItems.sessionId, id));
      expect(await advanceStatus(t.db, T3, id)).toBe("provisional");
      expect(await items(id)).toHaveLength(1);
    });

    it("a new provider snapshot raises a new item", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      await enterByHand(id);
      await ingest(
        t.db,
        T1,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      await advanceStatus(t.db, T1, id);
      await t.db
        .update(reviewItems)
        .set({ status: "resolved", resolution: "keep", resolvedAt: T1 })
        .where(eq(reviewItems.sessionId, id));
      expect(await advanceStatus(t.db, T1, id)).toBe("provisional");

      const body = loadBody("jolpica/2026/r18-results.json");
      rowsOf(body, "Results")[0]!.laps = "55";
      await ingest(t.db, T2, id, "race", body);
      expect(await advanceStatus(t.db, T2, id)).toBe("under_review");
      expect((await items(id)).filter((i) => i.status === "open")).toHaveLength(
        1,
      );
    });

    it("a provider session never raises it", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await advanceStatus(t.db, T1, id);
      expect(
        (await items(id)).filter((i) => i.kind === "provider_after_manual"),
      ).toEqual([]);
    });
  });
});
