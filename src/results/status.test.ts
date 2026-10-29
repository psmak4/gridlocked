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
import type { Db } from "@/db/types";
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

  describe("what it returns: the change signal", () => {
    it("reports the previous and next status, whether it changed, and the results version", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const first = await advanceStatus(t.db, T1, id);
      expect(first).toEqual({
        previous: "awaiting",
        next: "provisional",
        changed: true,
        resultsVersion: (await state(id))!.version,
      });

      // Nothing happened: the same answer, unchanged, at the same version.
      expect(await advanceStatus(t.db, T2, id)).toEqual({
        previous: "provisional",
        next: "provisional",
        changed: false,
        resultsVersion: first.resultsVersion,
      });
    });

    it("the version moves when the effective results change, even if the status does not", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const before = await advanceStatus(t.db, T1, id);
      const driverId = await idFor(t.db, "driver", "russell");

      await addOverride(t.db, T2, {
        sessionId: id,
        driverId,
        kind: "patch",
        fields: { fastest_lap_ms: 91234 },
        reason: "stewards",
        createdBy: ADMIN,
      });
      const after = await advanceStatus(t.db, T2, id);
      expect(after).toMatchObject({
        previous: "provisional",
        next: "provisional",
        changed: false,
      });
      expect(after.resultsVersion).toBe(before.resultsVersion + 1);
      expect(after.resultsVersion).toBe((await state(id))!.version);
    });

    it("a final session answers final to final, unchanged", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await advanceStatus(t.db, T1, id);
      await t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: T1 })
        .where(eq(sessionResultState.sessionId, id));
      expect(await advanceStatus(t.db, T2, id)).toEqual({
        previous: "final",
        next: "final",
        changed: false,
        resultsVersion: (await state(id))!.version,
      });
    });

    it("a session with no state row yet is previously awaiting", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      expect(await advanceStatus(t.db, T1, id)).toMatchObject({
        previous: "awaiting",
        next: "awaiting",
        changed: false,
      });
    });
  });

  describe("a complete, clean session", () => {
    it("moves awaiting to provisional, and creates the state row if needed", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      expect((await state(id))!.status).toBe("awaiting");

      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
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
      expect((await advanceStatus(t.db, T2, id)).next).toBe("provisional");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
    });

    it("leaves a final session alone", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      // An override that would raise a finding, made before the session closed.
      await patchOverride(id, "russell", { constructor_id: await ferrari() });
      await t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: T1 })
        .where(eq(sessionResultState.sessionId, id));
      expect((await advanceStatus(t.db, T2, id)).next).toBe("final");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("awaiting");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("awaiting");
      expect(await items(id)).toEqual([]);

      await revokeOverride(t.db, T2, suppress, ADMIN);
      expect((await advanceStatus(t.db, T2, id)).next).toBe("provisional");
    });

    it("a provisional session that loses a row is held for review, not sent back to awaiting", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await advanceStatus(t.db, T1, id);
      const russell = await idFor(t.db, "driver", "russell");
      const suppress = await addOverride(t.db, T2, {
        sessionId: id,
        driverId: russell,
        kind: "suppress",
        reason: "drop one",
        createdBy: ADMIN,
      });
      expect((await advanceStatus(t.db, T2, id)).next).toBe("under_review");

      const [item] = await items(id);
      expect(item).toMatchObject({
        kind: "missing_driver",
        severity: "blocking",
        status: "open",
        driverId: russell,
        dedupeKey: `validate:${id}:missing_driver:${russell}`,
        createdAt: T2,
      });
      expect(item!.details).toMatchObject({
        problem: "missing_driver",
        driverId: russell,
        afterResults: true,
      });

      // The row comes back: the finding clears and the session advances.
      await revokeOverride(t.db, T3, suppress, ADMIN);
      expect((await advanceStatus(t.db, T3, id)).next).toBe("provisional");
      expect(await items(id)).toEqual([
        expect.objectContaining({
          status: "resolved",
          resolution: "auto: no longer detected",
        }),
      ]);
    });

    it("an under_review session that loses a row also opens a missing_driver item", async () => {
      const id = await raceWithRussellIn("ferrari");
      expect((await advanceStatus(t.db, T1, id)).next).toBe("under_review");
      const hamilton = await idFor(t.db, "driver", "hamilton");
      await addOverride(t.db, T2, {
        sessionId: id,
        driverId: hamilton,
        kind: "suppress",
        reason: "drop one",
        createdBy: ADMIN,
      });
      expect((await advanceStatus(t.db, T2, id)).next).toBe("under_review");
      expect(
        (await items(id)).find(
          (i) => i.dedupeKey === `validate:${id}:missing_driver:${hamilton}`,
        ),
      ).toMatchObject({ status: "open", severity: "blocking" });
    });

    it("an awaiting session stays awaiting and gets no missing_driver items", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "suppress",
        reason: "drop one",
        createdBy: ADMIN,
      });
      expect((await advanceStatus(t.db, T1, id)).next).toBe("awaiting");
      expect(await items(id)).toEqual([]);
    });
  });

  describe("a roster surprise", () => {
    it("opens a blocking team_change and moves to under_review", async () => {
      const id = await raceWithRussellIn("ferrari");
      expect((await advanceStatus(t.db, T1, id)).next).toBe("under_review");

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

      expect((await advanceStatus(t.db, T2, id)).next).toBe("provisional");
      // The decided findings were not reopened.
      expect((await items(id)).every((i) => i.status === "resolved")).toBe(
        true,
      );
      expect((await advanceStatus(t.db, T3, id)).next).toBe("provisional");
    });

    it("a finding the admin dismissed is not reopened, but a changed finding is", async () => {
      const id = await raceWithRussellIn("ferrari");
      await advanceStatus(t.db, T1, id);
      await t.db
        .update(reviewItems)
        .set({ status: "dismissed", resolution: "ignore", resolvedAt: T2 })
        .where(eq(reviewItems.sessionId, id));
      expect((await advanceStatus(t.db, T2, id)).next).toBe("provisional");

      // The car number changes: not the thing the admin decided on.
      await addOverride(t.db, T2, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "patch",
        fields: { car_number: 99 },
        reason: "test",
        createdBy: ADMIN,
      });
      expect((await advanceStatus(t.db, T3, id)).next).toBe("under_review");
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
      expect((await advanceStatus(t.db, T3, id)).next).toBe("under_review");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("under_review");

      await revokeOverride(t.db, T2, bad, ADMIN);
      expect((await advanceStatus(t.db, T2, id)).next).toBe("provisional");
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
      expect((await advanceStatus(t.db, T3, id)).next).toBe("under_review");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("under_review");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
    });

    it("under_review goes to provisional once the problem and the items are gone", async () => {
      const id = await raceWithRussellIn("ferrari");
      expect((await advanceStatus(t.db, T1, id)).next).toBe("under_review");
      // A corrected provider response.
      await ingest(
        t.db,
        T2,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      expect((await advanceStatus(t.db, T2, id)).next).toBe("provisional");
    });
  });

  describe("item updates only touch open items", () => {
    /**
     * A Db whose transactions behave as if an admin resolved every open item
     * of the session just before our first write to `review_items`: our
     * earlier read of those items is then stale.
     */
    function adminResolvesBeforeFirstItemWrite(sessionId: string): Db {
      let fired = false;
      const wrapTx = (tx: Db): Db =>
        new Proxy(tx, {
          get(target, prop) {
            if (prop === "update") {
              return (table: typeof reviewItems) => {
                const real = target.update(table);
                if (table !== reviewItems || fired) return real;
                fired = true;
                // The write is delayed until the admin's has landed.
                return {
                  set: (values: Parameters<typeof real.set>[0]) => ({
                    where: (
                      cond: Parameters<ReturnType<typeof real.set>["where"]>[0],
                    ) => ({
                      then: (
                        resolve: (v: unknown) => unknown,
                        reject: (e: unknown) => unknown,
                      ) =>
                        target
                          .update(reviewItems)
                          .set({
                            status: "resolved",
                            resolution: "admin says fine",
                            resolvedBy: ADMIN,
                            resolvedAt: T2,
                          })
                          .where(
                            and(
                              eq(reviewItems.sessionId, sessionId),
                              eq(reviewItems.status, "open"),
                            ),
                          )
                          .then(() => real.set(values).where(cond))
                          .then(resolve, reject),
                    }),
                  }),
                };
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return new Proxy(t.db, {
        get(target, prop) {
          if (prop === "transaction") {
            return (cb: (tx: Db) => Promise<unknown>) =>
              target.transaction((tx) => cb(wrapTx(tx as unknown as Db)));
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Db;
    }

    it("does not overwrite an admin resolution when refreshing details", async () => {
      const id = await raceWithRussellIn("ferrari");
      await advanceStatus(t.db, T1, id);
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: await idFor(t.db, "driver", "russell"),
        kind: "patch",
        fields: { car_number: 99 },
        reason: "test",
        createdBy: ADMIN,
      });
      await advanceStatus(adminResolvesBeforeFirstItemWrite(id), T3, id);

      const team = (await items(id)).find((i) => i.kind === "team_change")!;
      expect(team).toMatchObject({
        status: "resolved",
        resolution: "admin says fine",
        resolvedBy: ADMIN,
        resolvedAt: T2,
      });
      expect(team.details).toMatchObject({ carNumber: 63 });
    });

    it("does not overwrite an admin resolution when auto-resolving", async () => {
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
      await advanceStatus(t.db, T1, id);
      await revokeOverride(t.db, T2, bad, ADMIN);
      await advanceStatus(adminResolvesBeforeFirstItemWrite(id), T3, id);

      for (const item of await items(id)) {
        expect(item).toMatchObject({
          status: "resolved",
          resolution: "admin says fine",
          resolvedBy: ADMIN,
          resolvedAt: T2,
        });
      }
    });
  });

  describe("more recorded sessions reach provisional", () => {
    it("a sprint (round 2) is provisional with no review items", async () => {
      const id = await ingestRecorded(t.db, T0, 2, "sprint", "r02-sprint.json");
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
      expect(await items(id)).toEqual([]);
    });

    it("qualifying with a driver's Q times removed is provisional", async () => {
      const id = await sessionIdFor(t.db, 18, "qualifying");
      await seedEntriesFor(t.db, id);
      const body = loadBody("jolpica/2026/r18-qualifying.json");
      const row = rowsOf(body, "QualifyingResults").find(
        (r) => (r.Driver as { driverId: string }).driverId === "bottas",
      )!;
      delete row.Q1;
      delete row.Q2;
      delete row.Q3;
      await ingest(t.db, T0, id, "qualifying", body);

      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
      expect(await items(id)).toEqual([]);
    });

    it.each([
      [12, "r12-results.json"],
      [13, "r13-results.json"],
      [14, "r14-results.json"],
      [15, "r15-results.json"],
      [16, "r16-results.json"],
      [17, "r17-results.json"],
    ])("round %i race is provisional", async (round, file) => {
      const id = await ingestRecorded(t.db, T0, round, "race", file);
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
      expect(await items(id)).toEqual([]);
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");
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
      expect((await advanceStatus(t.db, T2, id)).next).toBe("under_review");

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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("under_review");
      expect((await advanceStatus(t.db, T2, id)).next).toBe("under_review");
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
      expect((await advanceStatus(t.db, T3, id)).next).toBe("provisional");
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
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");

      const body = loadBody("jolpica/2026/r18-results.json");
      rowsOf(body, "Results")[0]!.laps = "55";
      await ingest(t.db, T2, id, "race", body);
      expect((await advanceStatus(t.db, T2, id)).next).toBe("under_review");
      expect((await items(id)).filter((i) => i.status === "open")).toHaveLength(
        1,
      );
    });

    it("revoking a manual insert from a provisional session holds it for review", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      await enterByHand(id);
      expect((await advanceStatus(t.db, T1, id)).next).toBe("provisional");

      const [insert] = await activeInserts(id);
      await revokeOverride(t.db, T2, insert!.id, ADMIN);
      expect((await advanceStatus(t.db, T2, id)).next).toBe("under_review");
      const [item] = await items(id);
      expect(item).toMatchObject({
        kind: "missing_driver",
        severity: "blocking",
        status: "open",
        driverId: insert!.driverId,
      });
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
