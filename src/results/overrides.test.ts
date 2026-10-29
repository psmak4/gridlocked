import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  idFor,
  ingestRecorded,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import {
  effectiveResults,
  resultOverrides,
  sessionResultState,
} from "@/db/schema";
import {
  addOverride,
  resultFieldsSchema,
  revokeOverride,
  SessionFinalError,
} from "./overrides";

describe("result override fields", () => {
  const insertFields = {
    constructor_id: "0198f3e0-0000-7000-8000-000000000001",
    car_number: 99,
    classification: "classified",
    provider_status: "Finished",
    provider_position_text: "1",
  };

  it("accepts an insert with the five required keys and any others", () => {
    expect(
      resultFieldsSchema.safeParse({ ...insertFields, position: 1, grid: null })
        .success,
    ).toBe(true);
  });

  it("accepts a patch of any subset, and null for a nullable column", () => {
    expect(resultFieldsSchema.safeParse({ position: null }).success).toBe(true);
    expect(resultFieldsSchema.safeParse({ laps: 56 }).success).toBe(true);
    expect(resultFieldsSchema.safeParse({ q1_ms: null }).success).toBe(true);
  });

  it("rejects null for every column that is NOT NULL in results", () => {
    for (const key of Object.keys(insertFields)) {
      expect(
        resultFieldsSchema.safeParse({ [key]: null }).success,
        `${key}: null`,
      ).toBe(false);
    }
    expect(resultFieldsSchema.safeParse({ pit_lane_start: null }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys, columns an override cannot set and wrong types", () => {
    for (const bad of [
      { nonsense: 1 },
      { session_id: insertFields.constructor_id },
      { driver_id: insertFields.constructor_id },
      { snapshot_id: insertFields.constructor_id },
      { session_kind: "race" },
      { car_number: "12" },
      { car_number: 1.5 },
      { classification: "winner" },
      { constructor_id: "not-a-uuid" },
      { pit_lane_start: "yes" },
    ]) {
      expect(
        resultFieldsSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe("addOverride and revokeOverride", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const T0 = new Date("2026-10-04T08:00:00.000Z");
  const T1 = new Date("2026-10-04T09:00:00.000Z");
  const T2 = new Date("2026-10-04T10:00:00.000Z");
  const ADMIN = "0198f3e0-0000-7000-8000-0000000000aa";
  const ADMIN2 = "0198f3e0-0000-7000-8000-0000000000bb";
  let sessionId: string;
  let antonelli: string;
  let russell: string;

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    sessionId = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
    antonelli = await idFor(t.db, "driver", "antonelli");
    russell = await idFor(t.db, "driver", "russell");
  });
  afterEach(async () => {
    await t.close();
  });

  const effective = async (driverId: string) =>
    (
      await t.db
        .select()
        .from(effectiveResults)
        .where(
          and(
            eq(effectiveResults.sessionId, sessionId),
            eq(effectiveResults.driverId, driverId),
          ),
        )
    )[0];
  const overrides = (driverId: string) =>
    t.db
      .select()
      .from(resultOverrides)
      .where(
        and(
          eq(resultOverrides.sessionId, sessionId),
          eq(resultOverrides.driverId, driverId),
        ),
      );

  it("a patch changes what effective_results shows, with the reason", async () => {
    expect((await effective(antonelli))!.position).toBe(1);
    const id = await addOverride(t.db, T1, {
      sessionId,
      driverId: antonelli,
      kind: "patch",
      fields: { position: 3, time_ms: null },
      reason: "Stewards: 10 s penalty",
      createdBy: ADMIN,
    });

    const [row] = await overrides(antonelli);
    expect(row).toMatchObject({
      id,
      kind: "patch",
      fields: { position: 3, time_ms: null },
      reason: "Stewards: 10 s penalty",
      createdBy: ADMIN,
      createdAt: T1,
      revokedAt: null,
      revokedBy: null,
    });
    expect(await effective(antonelli)).toMatchObject({
      position: 3,
      timeMs: null,
      overridden: true,
      overrideReason: "Stewards: 10 s penalty",
    });
  });

  it("a second override for the same driver revokes the first, in one step", async () => {
    const first = await addOverride(t.db, T1, {
      sessionId,
      driverId: antonelli,
      kind: "patch",
      fields: { position: 3 },
      reason: "first",
      createdBy: ADMIN,
    });
    const second = await addOverride(t.db, T2, {
      sessionId,
      driverId: antonelli,
      kind: "patch",
      fields: { position: 2 },
      reason: "second",
      createdBy: ADMIN2,
    });

    const rows = await overrides(antonelli);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first)).toMatchObject({
      revokedAt: T2,
      revokedBy: ADMIN2,
    });
    expect(rows.find((r) => r.id === second)!.revokedAt).toBeNull();
    expect(await effective(antonelli)).toMatchObject({
      position: 2,
      overrideReason: "second",
    });
  });

  it("revoking reverts to the provider value and records who and when", async () => {
    const id = await addOverride(t.db, T1, {
      sessionId,
      driverId: antonelli,
      kind: "patch",
      fields: { position: 3 },
      reason: "oops",
      createdBy: ADMIN,
    });
    await revokeOverride(t.db, T2, id, ADMIN2);

    const [row] = await overrides(antonelli);
    expect(row).toMatchObject({ revokedAt: T2, revokedBy: ADMIN2 });
    expect(await effective(antonelli)).toMatchObject({
      position: 1,
      overridden: false,
      overrideReason: null,
    });
  });

  it("refuses to revoke an override that is gone or already revoked", async () => {
    const id = await addOverride(t.db, T1, {
      sessionId,
      driverId: antonelli,
      kind: "suppress",
      reason: "bogus",
      createdBy: ADMIN,
    });
    await revokeOverride(t.db, T2, id, ADMIN);
    await expect(revokeOverride(t.db, T2, id, ADMIN)).rejects.toThrow(
      /already revoked/,
    );
    await expect(
      revokeOverride(t.db, T2, "0198f3e0-0000-7000-8000-0000000000ff", ADMIN),
    ).rejects.toThrow(/no override/);
  });

  it("a suppress removes the provider row from effective_results", async () => {
    await addOverride(t.db, T1, {
      sessionId,
      driverId: russell,
      kind: "suppress",
      reason: "bogus row",
      createdBy: ADMIN,
    });
    expect(await effective(russell)).toBeUndefined();
    const [row] = await overrides(russell);
    expect(row!.fields).toEqual({});
  });

  it("an insert adds a row the provider does not have", async () => {
    await addOverride(t.db, T1, {
      sessionId,
      driverId: russell,
      kind: "suppress",
      reason: "will re-enter",
      createdBy: ADMIN,
    });
    const mercedes = await idFor(t.db, "constructor", "mercedes");
    await addOverride(t.db, T2, {
      sessionId,
      driverId: russell,
      kind: "insert",
      fields: {
        constructor_id: mercedes,
        car_number: 63,
        classification: "classified",
        provider_status: "Finished",
        provider_position_text: "2",
        position: 2,
      },
      reason: "entered by hand",
      createdBy: ADMIN,
    });
    expect(await effective(russell)).toMatchObject({
      position: 2,
      carNumber: 63,
      snapshotId: null,
      overridden: true,
      overrideReason: "entered by hand",
    });
  });

  it("validates fields against the kind", async () => {
    const base = {
      sessionId,
      driverId: antonelli,
      reason: "r",
      createdBy: ADMIN,
    };
    // patch: at least one key.
    await expect(
      addOverride(t.db, T1, { ...base, kind: "patch", fields: {} }),
    ).rejects.toThrow();
    await expect(
      addOverride(t.db, T1, { ...base, kind: "patch" }),
    ).rejects.toThrow();
    // insert: all five keys.
    await expect(
      addOverride(t.db, T1, {
        ...base,
        kind: "insert",
        fields: { car_number: 12, position: 1 },
      }),
    ).rejects.toThrow(/insert/);
    // suppress: no fields.
    await expect(
      addOverride(t.db, T1, {
        ...base,
        kind: "suppress",
        fields: { position: 1 },
      }),
    ).rejects.toThrow(/suppress/);
    // NOT NULL columns cannot be nulled, nor unknown keys used.
    await expect(
      addOverride(t.db, T1, {
        ...base,
        kind: "patch",
        fields: { classification: null } as never,
      }),
    ).rejects.toThrow();
    await expect(
      addOverride(t.db, T1, {
        ...base,
        kind: "patch",
        fields: { nonsense: 1 } as never,
      }),
    ).rejects.toThrow();
    expect(await overrides(antonelli)).toEqual([]);
  });

  it("a rejected override leaves the existing one active", async () => {
    await addOverride(t.db, T1, {
      sessionId,
      driverId: antonelli,
      kind: "patch",
      fields: { position: 3 },
      reason: "keep",
      createdBy: ADMIN,
    });
    await expect(
      addOverride(t.db, T2, {
        sessionId,
        driverId: antonelli,
        kind: "patch",
        fields: { car_number: null } as never,
        reason: "bad",
        createdBy: ADMIN,
      }),
    ).rejects.toThrow();
    const rows = await overrides(antonelli);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });

  describe("the results version", () => {
    const version = async () =>
      (
        await t.db
          .select()
          .from(sessionResultState)
          .where(eq(sessionResultState.sessionId, sessionId))
      )[0]!.version;
    const patch = (at: Date, position: number, reason = "stewards") =>
      addOverride(t.db, at, {
        sessionId,
        driverId: antonelli,
        kind: "patch",
        fields: { position },
        reason,
        createdBy: ADMIN,
      });

    it("addOverride and revokeOverride each bump session_result_state.version", async () => {
      const v0 = await version();
      const id = await patch(T1, 3);
      expect(await version()).toBe(v0 + 1);

      // Replacing is one add: one bump, though it revokes the first too.
      await patch(T2, 2, "second");
      expect(await version()).toBe(v0 + 2);

      const [active] = (await overrides(antonelli)).filter(
        (o) => o.revokedAt === null,
      );
      await revokeOverride(t.db, T2, active!.id, ADMIN2);
      expect(await version()).toBe(v0 + 3);
      expect(id).not.toBe(active!.id);
    });

    it("a refused revoke bumps nothing", async () => {
      const id = await patch(T1, 3);
      await revokeOverride(t.db, T2, id, ADMIN);
      const v = await version();
      await expect(revokeOverride(t.db, T2, id, ADMIN)).rejects.toThrow(
        /already revoked/,
      );
      expect(await version()).toBe(v);
    });
  });

  describe("a final session", () => {
    const makeFinal = () =>
      t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: T1 })
        .where(eq(sessionResultState.sessionId, sessionId));

    it("refuses addOverride with SessionFinalError, writing nothing", async () => {
      await makeFinal();
      const before = await t.db.select().from(sessionResultState);
      const attempt = addOverride(t.db, T2, {
        sessionId,
        driverId: antonelli,
        kind: "patch",
        fields: { position: 3 },
        reason: "too late",
        createdBy: ADMIN,
      });
      await expect(attempt).rejects.toBeInstanceOf(SessionFinalError);
      await expect(attempt).rejects.toThrow(
        "session is final: reopen it first",
      );
      expect(await overrides(antonelli)).toEqual([]);
      expect(await t.db.select().from(sessionResultState)).toEqual(before);
    });

    it("refuses revokeOverride, leaving the override active", async () => {
      const id = await addOverride(t.db, T1, {
        sessionId,
        driverId: antonelli,
        kind: "patch",
        fields: { position: 3 },
        reason: "stewards",
        createdBy: ADMIN,
      });
      await makeFinal();
      const before = await t.db.select().from(sessionResultState);

      const attempt = revokeOverride(t.db, T2, id, ADMIN2);
      await expect(attempt).rejects.toBeInstanceOf(SessionFinalError);
      await expect(attempt).rejects.toThrow(
        "session is final: reopen it first",
      );
      const [row] = await overrides(antonelli);
      expect(row).toMatchObject({ revokedAt: null, revokedBy: null });
      expect(await t.db.select().from(sessionResultState)).toEqual(before);
    });

    it("still says an override that does not exist does not exist", async () => {
      await makeFinal();
      await expect(
        revokeOverride(t.db, T2, "0198f3e0-0000-7000-8000-0000000000cc", ADMIN),
      ).rejects.toThrow(/no override/);
    });
  });
});
