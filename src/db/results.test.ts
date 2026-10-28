import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { newId } from "@/lib/ids";
import {
  circuits,
  constructors,
  drivers,
  effectiveResults,
  events,
  jobs,
  providerRequests,
  rawSnapshots,
  resultOverrides,
  results,
  reviewItems,
  seasons,
  sessionParticipants,
  sessionResultState,
  sessions,
  SESSION_KINDS,
} from "./schema";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * Asserts that `promise` rejects with the given Postgres SQLSTATE (and, when
 * given, a message containing `message`). Drizzle wraps driver errors, so the
 * code is read from the error or its cause.
 */
async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").toBeDefined();
  const direct = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  expect(direct ?? cause).toBe(code);
  if (message !== undefined) {
    const causeMessage = (error as { cause?: { message?: string } }).cause
      ?.message;
    expect(`${(error as Error).message} ${causeMessage ?? ""}`).toContain(
      message,
    );
  }
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const INTEGRITY_CONSTRAINT_VIOLATION = "23000";

const NOW = new Date("2026-06-07T15:00:00Z");

describe("ingestion and results schema (DM Part 2)", () => {
  let t: TestDb;
  let seasonId: string;
  let eventId: string;
  let driverA: string;
  let driverB: string;
  let constructorId: string;

  beforeEach(async () => {
    t = await createTestDb();
    seasonId = newId();
    await t.db
      .insert(seasons)
      .values({ id: seasonId, year: 2026, status: "active" });
    const circuitId = newId();
    await t.db.insert(circuits).values({
      id: circuitId,
      slug: "monaco",
      name: "Circuit de Monaco",
      locality: "Monte-Carlo",
      country: "Monaco",
      latitude: "43.734700",
      longitude: "7.420560",
      timezone: "Europe/Monaco",
    });
    eventId = newId();
    await t.db.insert(events).values({
      id: eventId,
      seasonId,
      round: 1,
      slug: "2026-monaco",
      name: "Monaco Grand Prix",
      circuitId,
      format: "sprint",
      status: "scheduled",
      lockAt: NOW,
      lockAtSource: "default",
    });
    driverA = await insertDriver("verstappen");
    driverB = await insertDriver("norris");
    constructorId = newId();
    await t.db.insert(constructors).values({
      id: constructorId,
      slug: "mclaren",
      name: "McLaren",
      nationality: "British",
    });
  });

  afterEach(async () => {
    await t.close();
  });

  async function insertDriver(slug: string) {
    const id = newId();
    await t.db.insert(drivers).values({
      id,
      slug,
      givenName: "Given",
      familyName: slug,
      nationality: "Dutch",
    });
    return id;
  }

  const sessionCounter = { n: 0 };
  async function insertSession(kind: SessionKind) {
    const id = newId();
    sessionCounter.n += 1;
    await t.db.insert(sessions).values({
      id,
      eventId,
      kind,
      sequence: sessionCounter.n,
      scheduledStart: NOW,
      startConfirmed: true,
      scheduledEnd: new Date(NOW.getTime() + 3600_000),
      timeSource: "provider",
      status: "completed",
    });
    return id;
  }

  async function insertSnapshot(sessionId: string | null = null) {
    const id = newId();
    await t.db.insert(rawSnapshots).values({
      id,
      provider: "jolpica",
      endpoint: "/2026/1/results",
      paramsHash: `params-${id}`,
      contentHash: `content-${id}`,
      body: { MRData: {} },
      bodyBytes: 12,
      firstFetchedAt: NOW,
      lastSeenAt: NOW,
      seasonId,
      eventId,
      sessionId,
    });
    return id;
  }

  /** Inserts a result row; the trigger fills session_kind. */
  async function insertResult(
    sessionId: string,
    driverId: string,
    snapshotId: string,
    overrides: Partial<typeof results.$inferInsert> = {},
  ) {
    await t.db.insert(results).values({
      sessionId,
      driverId,
      constructorId,
      snapshotId,
      carNumber: 4,
      position: 3,
      classification: "classified",
      providerStatus: "Finished",
      providerPositionText: "3",
      ...overrides,
    });
  }

  async function effective(sessionId: string) {
    const res = await t.db.execute<{
      driver_id: string;
      position: number | null;
      car_number: number;
      constructor_id: string;
      classification: string;
      overridden: boolean;
      override_reason: string | null;
      session_kind: string;
      grid: number | null;
      time_ms: string | null;
    }>(
      sql`select * from effective_results where session_id = ${sessionId} order by position nulls last, driver_id`,
    );
    return res.rows;
  }

  function override(
    sessionId: string,
    driverId: string,
    kind: "patch" | "insert" | "suppress",
    fields: Record<string, unknown> = {},
    reason = "stewards decision",
  ) {
    const id = newId();
    return t.db
      .insert(resultOverrides)
      .values({
        id,
        sessionId,
        driverId,
        kind,
        fields,
        reason,
        createdBy: newId(),
        createdAt: NOW,
      })
      .then(() => id);
  }

  describe("results: session-specific CHECKs and session_kind", () => {
    it("copies sessions.kind into the row on insert", async () => {
      const sessionId = await insertSession("race");
      await insertResult(sessionId, driverA, await insertSnapshot(sessionId), {
        grid: 2,
      });

      const [row] = await t.db.select().from(results);
      expect(row?.sessionKind).toBe("race");
    });

    it("ignores a session_kind supplied by the caller", async () => {
      const sessionId = await insertSession("race");
      await insertResult(sessionId, driverA, await insertSnapshot(sessionId), {
        sessionKind: "qualifying",
      });

      const [row] = await t.db.select().from(results);
      expect(row?.sessionKind).toBe("race");
    });

    it("rejects a result for a session that does not exist with a foreign key violation", async () => {
      const snapshotId = await insertSnapshot();
      await expectPgError(
        insertResult(newId(), driverA, snapshotId),
        FOREIGN_KEY_VIOLATION,
      );
    });

    it("recomputes session_kind when session_id changes, and when someone sets it directly", async () => {
      const raceId = await insertSession("race");
      const sprintId = await insertSession("sprint");
      const snapshotId = await insertSnapshot();
      await insertResult(raceId, driverA, snapshotId);

      await t.db
        .update(results)
        .set({ sessionId: sprintId })
        .where(eq(results.driverId, driverA));
      let [row] = await t.db.select().from(results);
      expect(row?.sessionKind).toBe("sprint");

      await t.db
        .update(results)
        .set({ sessionKind: "fp1" })
        .where(eq(results.driverId, driverA));
      [row] = await t.db.select().from(results);
      expect(row?.sessionKind).toBe("sprint");
    });

    it("rejects moving a row to a session whose kind its columns do not fit", async () => {
      const raceId = await insertSession("race");
      const qualifyingId = await insertSession("qualifying");
      await insertResult(raceId, driverA, await insertSnapshot(), { grid: 5 });

      await expectPgError(
        t.db
          .update(results)
          .set({ sessionId: qualifyingId })
          .where(eq(results.driverId, driverA)),
        CHECK_VIOLATION,
      );
    });

    it("rejects grid on a qualifying row", async () => {
      const sessionId = await insertSession("qualifying");
      await expectPgError(
        insertResult(sessionId, driverA, await insertSnapshot(), { grid: 5 }),
        CHECK_VIOLATION,
      );
    });

    it("rejects pit_lane_start on a practice row", async () => {
      const sessionId = await insertSession("fp1");
      await expectPgError(
        insertResult(sessionId, driverA, await insertSnapshot(), {
          pitLaneStart: true,
        }),
        CHECK_VIOLATION,
      );
    });

    it("rejects q times on a race row, and on a sprint row", async () => {
      const raceId = await insertSession("race");
      const sprintId = await insertSession("sprint");
      const snapshotId = await insertSnapshot();
      await expectPgError(
        insertResult(raceId, driverA, snapshotId, { q1Ms: 71000 }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        insertResult(sprintId, driverA, snapshotId, { q3Ms: 70000 }),
        CHECK_VIOLATION,
      );
    });

    it("accepts grid and a pit-lane start on sprint and race rows", async () => {
      const raceId = await insertSession("race");
      const sprintId = await insertSession("sprint");
      const snapshotId = await insertSnapshot();
      await insertResult(raceId, driverA, snapshotId, { grid: 5 });
      await insertResult(sprintId, driverA, snapshotId, {
        grid: null,
        pitLaneStart: true,
      });
      expect(await t.db.select().from(results)).toHaveLength(2);
    });

    it("accepts q times on qualifying and sprint qualifying rows, including all null", async () => {
      const qualifyingId = await insertSession("qualifying");
      const sprintQualifyingId = await insertSession("sprint_qualifying");
      const snapshotId = await insertSnapshot();
      await insertResult(qualifyingId, driverA, snapshotId, {
        q1Ms: 71000,
        q2Ms: 70500,
        q3Ms: 70000,
      });
      await insertResult(qualifyingId, driverB, snapshotId, {
        position: 20,
        q1Ms: null,
      });
      await insertResult(sprintQualifyingId, driverA, snapshotId, {
        q1Ms: 70900,
      });
      expect(await t.db.select().from(results)).toHaveLength(3);
    });

    it("rejects a grid on a pit-lane start", async () => {
      const sessionId = await insertSession("race");
      await expectPgError(
        insertResult(sessionId, driverA, await insertSnapshot(), {
          grid: 0,
          pitLaneStart: true,
        }),
        CHECK_VIOLATION,
      );
    });

    it("rejects an unknown classification", async () => {
      const sessionId = await insertSession("race");
      await expectPgError(
        insertResult(sessionId, driverA, await insertSnapshot(), {
          classification: "lapped" as never,
        }),
        CHECK_VIOLATION,
      );
    });

    it("rejects a second row for the same driver in a session", async () => {
      const sessionId = await insertSession("race");
      const snapshotId = await insertSnapshot();
      await insertResult(sessionId, driverA, snapshotId);
      await expectPgError(
        insertResult(sessionId, driverA, snapshotId),
        UNIQUE_VIOLATION,
      );
    });
  });

  describe("effective_results (DM 2.7)", () => {
    async function raceWithTwoDrivers() {
      const sessionId = await insertSession("race");
      const snapshotId = await insertSnapshot(sessionId);
      await insertResult(sessionId, driverA, snapshotId, {
        position: 6,
        grid: 3,
        timeMs: 5_400_000,
      });
      await insertResult(sessionId, driverB, snapshotId, {
        position: 7,
        carNumber: 81,
      });
      return sessionId;
    }

    it("returns provider rows unchanged and not overridden when there are no overrides", async () => {
      const sessionId = await raceWithTwoDrivers();
      const rows = await effective(sessionId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.overridden === false)).toBe(true);
      expect(rows.every((r) => r.override_reason === null)).toBe(true);
      expect(rows[0]).toMatchObject({
        driver_id: driverA,
        position: 6,
        grid: 3,
        session_kind: "race",
      });
    });

    it("can be read through the typed view handle", async () => {
      const sessionId = await raceWithTwoDrivers();
      await override(sessionId, driverA, "patch", { position: 8 });

      const rows = await t.db
        .select()
        .from(effectiveResults)
        .where(eq(effectiveResults.sessionId, sessionId));
      const patched = rows.find((r) => r.driverId === driverA);
      expect(patched).toMatchObject({
        position: 8,
        grid: 3,
        timeMs: 5_400_000,
        sessionKind: "race",
        overridden: true,
        overrideReason: "stewards decision",
      });
    });

    it("applies a patch field by field, flags it and carries the reason", async () => {
      const sessionId = await raceWithTwoDrivers();
      await override(sessionId, driverA, "patch", { position: 8 });

      const rows = await effective(sessionId);
      const patched = rows.find((r) => r.driver_id === driverA);
      expect(patched).toMatchObject({
        position: 8,
        overridden: true,
        override_reason: "stewards decision",
        // Fields the patch does not mention keep the provider value.
        grid: 3,
        car_number: 4,
        classification: "classified",
      });
      expect(Number(patched?.time_ms)).toBe(5_400_000);
      expect(rows.find((r) => r.driver_id === driverB)).toMatchObject({
        position: 7,
        overridden: false,
      });
    });

    it("lets a patch set a field to null and change classification", async () => {
      const sessionId = await raceWithTwoDrivers();
      await override(sessionId, driverA, "patch", {
        position: null,
        classification: "disqualified",
      });

      const patched = (await effective(sessionId)).find(
        (r) => r.driver_id === driverA,
      );
      expect(patched).toMatchObject({
        position: null,
        classification: "disqualified",
        overridden: true,
      });
    });

    it("shows the provider value again once the patch is revoked", async () => {
      const sessionId = await raceWithTwoDrivers();
      const overrideId = await override(sessionId, driverA, "patch", {
        position: 8,
      });
      await t.db
        .update(resultOverrides)
        .set({ revokedAt: NOW, revokedBy: newId() })
        .where(eq(resultOverrides.id, overrideId));

      const row = (await effective(sessionId)).find(
        (r) => r.driver_id === driverA,
      );
      expect(row).toMatchObject({
        position: 6,
        overridden: false,
        override_reason: null,
      });
    });

    it("hides a row with an active suppress", async () => {
      const sessionId = await raceWithTwoDrivers();
      await override(sessionId, driverB, "suppress", {}, "bogus provider row");

      const rows = await effective(sessionId);
      expect(rows.map((r) => r.driver_id)).toEqual([driverA]);
    });

    it("adds a row the provider lacks for an active insert, built from fields", async () => {
      const sessionId = await raceWithTwoDrivers();
      const third = await insertDriver("piastri");
      await override(
        sessionId,
        third,
        "insert",
        {
          constructor_id: constructorId,
          car_number: 81,
          position: 9,
          classification: "classified",
          provider_status: "Finished",
          provider_position_text: "9",
          grid: 4,
        },
        "provider omitted this driver",
      );

      const rows = await effective(sessionId);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.driver_id === third)).toMatchObject({
        constructor_id: constructorId,
        car_number: 81,
        position: 9,
        grid: 4,
        session_kind: "race",
        overridden: true,
        override_reason: "provider omitted this driver",
      });
    });

    it("lets an insert win over a provider row for the same driver, with one row per driver", async () => {
      const sessionId = await raceWithTwoDrivers();
      await override(
        sessionId,
        driverA,
        "insert",
        {
          constructor_id: constructorId,
          car_number: 4,
          position: 1,
          classification: "classified",
          provider_status: "Finished",
          provider_position_text: "1",
        },
        "manual entry",
      );

      const rows = (await effective(sessionId)).filter(
        (r) => r.driver_id === driverA,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ position: 1, overridden: true });
    });

    it("only applies overrides to their own session", async () => {
      const sessionId = await raceWithTwoDrivers();
      const otherId = await insertSession("sprint");
      await insertResult(otherId, driverA, await insertSnapshot(otherId), {
        position: 2,
      });
      await override(sessionId, driverA, "patch", { position: 8 });

      expect(await effective(otherId)).toMatchObject([
        { position: 2, overridden: false },
      ]);
    });
  });

  describe("result_overrides", () => {
    it("rejects a second active override for the same driver and session", async () => {
      const sessionId = await insertSession("race");
      await override(sessionId, driverA, "patch", { position: 8 });
      await expectPgError(
        override(sessionId, driverA, "suppress"),
        UNIQUE_VIOLATION,
      );
    });

    it("allows a replacement once the earlier override is revoked", async () => {
      const sessionId = await insertSession("race");
      const first = await override(sessionId, driverA, "patch", {
        position: 8,
      });
      await t.db
        .update(resultOverrides)
        .set({ revokedAt: NOW, revokedBy: newId() })
        .where(eq(resultOverrides.id, first));
      await override(sessionId, driverA, "patch", { position: 9 });

      expect(await t.db.select().from(resultOverrides)).toHaveLength(2);
    });

    it("allows active overrides for different drivers or sessions", async () => {
      const raceId = await insertSession("race");
      const sprintId = await insertSession("sprint");
      await override(raceId, driverA, "patch", { position: 8 });
      await override(raceId, driverB, "patch", { position: 9 });
      await override(sprintId, driverA, "patch", { position: 1 });
      expect(await t.db.select().from(resultOverrides)).toHaveLength(3);
    });

    it("rejects an unknown kind, and fields that are not a JSON object", async () => {
      const sessionId = await insertSession("race");
      await expectPgError(
        override(sessionId, driverA, "replace" as never),
        CHECK_VIOLATION,
      );
      await expectPgError(
        t.db.insert(resultOverrides).values({
          id: newId(),
          sessionId,
          driverId: driverA,
          kind: "patch",
          fields: [1, 2],
          reason: "x",
          createdBy: newId(),
          createdAt: NOW,
        }),
        CHECK_VIOLATION,
      );
    });
  });

  describe("session_result_state: the blocking-review guard (DM 2.9)", () => {
    async function sessionWithState(
      status: "awaiting" | "under_review" = "awaiting",
    ) {
      const sessionId = await insertSession("race");
      await t.db
        .insert(sessionResultState)
        .values({ sessionId, status, source: "provider" });
      return sessionId;
    }

    function openItem(
      sessionId: string | null,
      severity: "blocking" | "warning",
      dedupeKey = `k-${newId()}`,
      status: "open" | "resolved" | "dismissed" = "open",
    ) {
      return t.db.insert(reviewItems).values({
        id: newId(),
        kind: "validation_failed",
        severity,
        sessionId,
        details: {},
        status,
        dedupeKey,
        createdAt: NOW,
      });
    }

    function setStatus(
      sessionId: string,
      status: "provisional" | "final" | "under_review" | "awaiting",
    ) {
      return t.db
        .update(sessionResultState)
        .set({ status })
        .where(eq(sessionResultState.sessionId, sessionId));
    }

    it("refuses provisional and final while an open blocking item exists", async () => {
      const sessionId = await sessionWithState("under_review");
      await openItem(sessionId, "blocking");

      await expectPgError(
        setStatus(sessionId, "provisional"),
        INTEGRITY_CONSTRAINT_VIOLATION,
        "open blocking review item",
      );
      await expectPgError(
        setStatus(sessionId, "final"),
        INTEGRITY_CONSTRAINT_VIOLATION,
        "open blocking review item",
      );
    });

    it("allows the change once the item is resolved or dismissed", async () => {
      const sessionId = await sessionWithState("under_review");
      await openItem(sessionId, "blocking", "resolved-one", "resolved");
      await openItem(sessionId, "blocking", "dismissed-one", "dismissed");

      await setStatus(sessionId, "provisional");
      const [row] = await t.db.select().from(sessionResultState);
      expect(row?.status).toBe("provisional");
    });

    it("lets the same item block, then allow, as it is resolved in place", async () => {
      const sessionId = await sessionWithState("under_review");
      await openItem(sessionId, "blocking", "will-resolve");
      await expectPgError(
        setStatus(sessionId, "provisional"),
        INTEGRITY_CONSTRAINT_VIOLATION,
      );

      await t.db
        .update(reviewItems)
        .set({ status: "resolved", resolvedAt: NOW, resolvedBy: newId() })
        .where(eq(reviewItems.dedupeKey, "will-resolve"));
      await setStatus(sessionId, "provisional");
    });

    it("is not blocked by a warning item or by a blocking item on another session", async () => {
      const sessionId = await sessionWithState("under_review");
      const other = await sessionWithState("under_review");
      await openItem(sessionId, "warning");
      await openItem(other, "blocking");

      await setStatus(sessionId, "final");
      const rows = await t.db.select().from(sessionResultState);
      expect(rows.find((r) => r.sessionId === sessionId)?.status).toBe("final");
      expect(rows.find((r) => r.sessionId === other)?.status).toBe(
        "under_review",
      );
    });

    it("does not stop moving to under_review or back to awaiting", async () => {
      const sessionId = await sessionWithState("awaiting");
      await openItem(sessionId, "blocking");

      await setStatus(sessionId, "under_review");
      await setStatus(sessionId, "awaiting");
    });

    it("does not re-check when other columns change while already provisional", async () => {
      const sessionId = await sessionWithState("under_review");
      await setStatus(sessionId, "provisional");
      await openItem(sessionId, "blocking");

      await t.db
        .update(sessionResultState)
        .set({ pollAttempts: 3 })
        .where(eq(sessionResultState.sessionId, sessionId));
      const [row] = await t.db.select().from(sessionResultState);
      expect(row).toMatchObject({ status: "provisional", pollAttempts: 3 });
    });

    it("also guards an insert that starts at provisional or final", async () => {
      const sessionId = await insertSession("race");
      await openItem(sessionId, "blocking");

      await expectPgError(
        t.db
          .insert(sessionResultState)
          .values({ sessionId, status: "final", source: "provider" }),
        INTEGRITY_CONSTRAINT_VIOLATION,
        "open blocking review item",
      );
    });

    it("rejects an unknown status or source", async () => {
      const sessionId = await insertSession("race");
      await expectPgError(
        t.db.insert(sessionResultState).values({
          sessionId,
          status: "done" as never,
          source: "provider",
        }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        t.db.insert(sessionResultState).values({
          sessionId,
          status: "awaiting",
          source: "scraper" as never,
        }),
        CHECK_VIOLATION,
      );
    });
  });

  describe("review_items", () => {
    function item(
      dedupeKey: string,
      status: "open" | "resolved" | "dismissed" = "open",
      overrides: Partial<typeof reviewItems.$inferInsert> = {},
    ) {
      return t.db.insert(reviewItems).values({
        id: newId(),
        kind: "some_future_kind",
        severity: "warning",
        details: { note: "x" },
        status,
        dedupeKey,
        createdAt: NOW,
        ...overrides,
      });
    }

    it("rejects a second open item with the same dedupe_key", async () => {
      await item("dup");
      await expectPgError(item("dup"), UNIQUE_VIOLATION);
    });

    it("lets a resolved or dismissed item coexist with a new open one", async () => {
      await item("dup", "resolved");
      await item("dup", "dismissed");
      await item("dup", "open");
      expect(await t.db.select().from(reviewItems)).toHaveLength(3);
    });

    it("has no CHECK on kind, but checks severity and status", async () => {
      await item("a", "open", { kind: "brand_new_kind" });
      await expectPgError(
        item("b", "open", { severity: "fatal" as never }),
        CHECK_VIOLATION,
      );
      await expectPgError(item("c", "pending" as never), CHECK_VIOLATION);
    });
  });

  describe("jobs", () => {
    function job(
      kind: string,
      dedupeKey: string,
      overrides: Partial<typeof jobs.$inferInsert> = {},
    ) {
      return t.db.insert(jobs).values({
        id: newId(),
        kind,
        dedupeKey,
        payload: {},
        runAt: NOW,
        status: "pending",
        maxAttempts: 5,
        ...overrides,
      });
    }

    it("rejects a duplicate (kind, dedupe_key)", async () => {
      await job("poll_session", "poll:s1:1");
      await expectPgError(job("poll_session", "poll:s1:1"), UNIQUE_VIOLATION);
    });

    it("allows the same dedupe_key under another kind", async () => {
      await job("poll_session", "same");
      await job("normalize", "same");
      expect(await t.db.select().from(jobs)).toHaveLength(2);
    });

    it("accepts any kind but checks status", async () => {
      await job("a_kind_nobody_listed", "k1");
      await expectPgError(
        job("poll_session", "k2", { status: "queued" as never }),
        CHECK_VIOLATION,
      );
    });

    it("supports a parent job, defaults attempts to 0 and the lease to null", async () => {
      await job("notify_league", "league:1");
      const [parent] = await t.db.select().from(jobs);
      await job("notify_batch", "league:1:0", { parentJobId: parent?.id });
      const rows = await t.db.select().from(jobs);
      expect(rows.find((r) => r.kind === "notify_batch")?.parentJobId).toBe(
        parent?.id,
      );
      expect(parent).toMatchObject({
        attempts: 0,
        lockedUntil: null,
        startedAt: null,
        finishedAt: null,
      });
    });

    it("has a partial index for due pending jobs", async () => {
      const res = await t.db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes where tablename = 'jobs'`,
      );
      expect(
        res.rows.some(
          (r) =>
            r.indexdef.includes("(run_at)") && r.indexdef.includes("pending"),
        ),
      ).toBe(true);
    });
  });

  describe("provider_requests, raw_snapshots, session_participants", () => {
    it("rejects an unknown request outcome and accepts a null status_code", async () => {
      const base = {
        provider: "jolpica",
        endpoint: "/2026/1/results",
        params: { limit: 100 },
        requestedAt: NOW,
        durationMs: 120,
      };
      await t.db.insert(providerRequests).values({
        id: newId(),
        ...base,
        statusCode: null,
        outcome: "error",
        error: "ECONNRESET",
      });
      await expectPgError(
        t.db.insert(providerRequests).values({
          id: newId(),
          ...base,
          statusCode: 200,
          outcome: "mystery" as never,
        }),
        CHECK_VIOLATION,
      );
    });

    it("links a request to the snapshot it produced and the job that made it", async () => {
      const snapshotId = await insertSnapshot();
      const jobId = newId();
      await t.db.insert(jobs).values({
        id: jobId,
        kind: "poll_session",
        dedupeKey: "poll:1",
        payload: {},
        runAt: NOW,
        status: "running",
        maxAttempts: 3,
      });
      await t.db.insert(providerRequests).values({
        id: newId(),
        provider: "jolpica",
        endpoint: "/2026/1/results",
        params: {},
        requestedAt: NOW,
        statusCode: 200,
        durationMs: 80,
        outcome: "new_snapshot",
        snapshotId,
        jobId,
      });
      await expectPgError(
        t.db.insert(providerRequests).values({
          id: newId(),
          provider: "jolpica",
          endpoint: "/x",
          params: {},
          requestedAt: NOW,
          durationMs: 1,
          outcome: "unchanged",
          snapshotId: newId(),
        }),
        FOREIGN_KEY_VIOLATION,
      );
    });

    it("stores the same answer to the same question once", async () => {
      const row = {
        provider: "jolpica",
        endpoint: "/2026/1/results",
        paramsHash: "p1",
        contentHash: "c1",
        body: { a: 1 },
        bodyBytes: 8,
        firstFetchedAt: NOW,
        lastSeenAt: NOW,
      };
      await t.db.insert(rawSnapshots).values({ id: newId(), ...row });
      await expectPgError(
        t.db.insert(rawSnapshots).values({ id: newId(), ...row }),
        UNIQUE_VIOLATION,
      );
      await t.db
        .insert(rawSnapshots)
        .values({ id: newId(), ...row, contentHash: "c2" });
    });

    it("keys session_participants by session and driver", async () => {
      const sessionId = await insertSession("fp2");
      const snapshotId = await insertSnapshot(sessionId);
      const row = {
        sessionId,
        driverId: driverA,
        constructorId,
        provider: "openf1",
        snapshotId,
      };
      await t.db.insert(sessionParticipants).values(row);
      await expectPgError(
        t.db.insert(sessionParticipants).values(row),
        UNIQUE_VIOLATION,
      );
    });
  });
});
