import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  idFor,
  ingest,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { loadBody, sessionIdFor } from "../../tests/helpers/results-2026";
import {
  auditLog,
  effectiveResults,
  eventEntries,
  resultOverrides,
  sessionResultState,
} from "@/db/schema";
import { SessionFinalError } from "@/results/overrides";
import { advanceStatus } from "@/results/status";
import { insertResult } from "./results";
import type { StaffActor } from "./roster";

const T0 = new Date("2026-08-01T15:00:00.000Z");
const T1 = new Date("2026-08-01T16:00:00.000Z");
const T2 = new Date("2026-08-01T17:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: "psmak4", requestId: "r1" };

// Round 14's qualifying: Jolpica lists nobody with no Q1 time, so the recorded
// session is short of Bearman and Stroll.
describe("insertResult", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let sessionId: string;
  let eventId: string;
  let bearman: string;
  let stroll: string;

  const entryOf = async (driverId: string) =>
    (
      await t.db
        .select()
        .from(eventEntries)
        .where(
          and(
            eq(eventEntries.eventId, eventId),
            eq(eventEntries.driverId, driverId),
          ),
        )
    )[0]!;
  const input = async (driverId: string, position: number) => {
    const entry = await entryOf(driverId);
    return {
      sessionId,
      driverId,
      constructorId: entry.constructorId,
      carNumber: entry.carNumber,
      position,
      classification: "classified" as const,
      reason: "Set no time in qualifying",
      actor: ACTOR,
    };
  };
  const state = async () =>
    (
      await t.db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0]!;
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

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    sessionId = await sessionIdFor(t.db, 14, "qualifying");
    eventId = await seedEntriesFor(t.db, sessionId);
    await ingest(
      t.db,
      T0,
      sessionId,
      "qualifying",
      loadBody("jolpica/2026/r14-qualifying.json"),
    );
    await advanceStatus(t.db, T0, sessionId);
    bearman = await idFor(t.db, "driver", "bearman");
    stroll = await idFor(t.db, "driver", "stroll");
  });
  afterEach(async () => {
    await t.close();
  });

  it("a session short of its no-time drivers reaches provisional once they are in", async () => {
    expect((await state()).status).toBe("awaiting");

    const first = await insertResult(t.db, T1, await input(bearman, 21));
    expect(first).toMatchObject({
      changed: true,
      sessions: [{ sessionId, previous: "awaiting", next: "awaiting" }],
    });

    const second = await insertResult(t.db, T1, await input(stroll, 22));
    expect(second).toMatchObject({
      changed: true,
      sessions: [{ sessionId, previous: "awaiting", next: "provisional" }],
    });
    expect((await state()).status).toBe("provisional");

    const [row] = await t.db
      .select()
      .from(effectiveResults)
      .where(
        and(
          eq(effectiveResults.sessionId, sessionId),
          eq(effectiveResults.driverId, bearman),
        ),
      );
    // No time: the Q columns stay null, which is how DM 2.4 reads "no time set".
    expect(row).toMatchObject({
      position: 21,
      classification: "classified",
      q1Ms: null,
      snapshotId: null,
      overridden: true,
      overrideReason: "Set no time in qualifying",
    });
  });

  it("writes the audit row in the transaction of the insert", async () => {
    await insertResult(t.db, T1, await input(bearman, 21));

    const [override] = await overrides(bearman);
    const entry = await entryOf(bearman);
    expect(await t.db.select().from(auditLog)).toMatchObject([
      {
        actorKind: "admin",
        actorLabel: "psmak4",
        requestId: "r1",
        action: "result_override.create",
        entityType: "result_override",
        entityId: override!.id,
        reason: "Set no time in qualifying",
        before: null,
        after: {
          sessionId,
          driverId: bearman,
          kind: "insert",
          fields: {
            constructor_id: entry.constructorId,
            car_number: entry.carNumber,
            position: 21,
            classification: "classified",
          },
        },
      },
    ]);
    expect(override).toMatchObject({
      kind: "insert",
      reason: "Set no time in qualifying",
    });
  });

  it("the same insert again changes nothing and writes no audit row", async () => {
    await insertResult(t.db, T1, await input(bearman, 21));
    const { version } = await state();

    const again = await insertResult(t.db, T2, await input(bearman, 21));

    expect(again.changed).toBe(false);
    expect((await state()).version).toBe(version);
    expect(await overrides(bearman)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it("a different insert replaces the active one, and the audit says what it was", async () => {
    await insertResult(t.db, T1, await input(bearman, 21));
    const [first] = await overrides(bearman);

    const moved = await insertResult(t.db, T2, await input(bearman, 22));

    expect(moved.changed).toBe(true);
    const rows = await overrides(bearman);
    expect(rows).toHaveLength(2);
    expect(rows.filter((o) => o.revokedAt === null)).toMatchObject([
      { fields: { position: 22 } },
    ]);
    const audits = await t.db.select().from(auditLog);
    expect(audits[1]!.before).toMatchObject({
      overrideId: first!.id,
      kind: "insert",
      fields: { position: 21 },
    });
  });

  it("a row with no position takes a placeholder for its position text", async () => {
    await insertResult(t.db, T1, {
      ...(await input(bearman, 21)),
      position: null,
      classification: "did_not_start",
    });

    const [override] = await overrides(bearman);
    expect(override!.fields).toMatchObject({
      position: null,
      classification: "did_not_start",
      provider_position_text: "-",
    });
  });

  describe("refusals write nothing", () => {
    const unchanged = async () => {
      expect(await t.db.select().from(resultOverrides)).toEqual([]);
      expect(await t.db.select().from(auditLog)).toEqual([]);
    };

    it("a blank reason", async () => {
      await expect(
        insertResult(t.db, T1, { ...(await input(bearman, 21)), reason: "  " }),
      ).rejects.toThrow(/reason/);
      await unchanged();
    });

    it("a driver with a provider row, who needs an override", async () => {
      const norris = await idFor(t.db, "driver", "norris");
      await expect(
        insertResult(t.db, T1, await input(norris, 21)),
      ).rejects.toThrow(/already has a result/);
      await unchanged();
    });

    it("a driver who isn't entered at the event", async () => {
      const entry = await entryOf(bearman);
      await t.db
        .delete(eventEntries)
        .where(
          and(
            eq(eventEntries.eventId, eventId),
            eq(eventEntries.driverId, bearman),
          ),
        );
      await expect(
        insertResult(t.db, T1, {
          sessionId,
          driverId: bearman,
          constructorId: entry.constructorId,
          carNumber: entry.carNumber,
          position: 21,
          classification: "classified",
          reason: "Set no time in qualifying",
          actor: ACTOR,
        }),
      ).rejects.toThrow(/isn't entered/);
      await unchanged();
    });

    it("a session that doesn't exist", async () => {
      await expect(
        insertResult(t.db, T1, {
          ...(await input(bearman, 21)),
          sessionId: "00000000-0000-7000-8000-000000000000",
        }),
      ).rejects.toThrow(/no session/);
      await unchanged();
    });

    it("a final session", async () => {
      const request = await input(bearman, 21);
      await t.db
        .update(sessionResultState)
        .set({ status: "final" })
        .where(eq(sessionResultState.sessionId, sessionId));
      await expect(insertResult(t.db, T1, request)).rejects.toBeInstanceOf(
        SessionFinalError,
      );
      await unchanged();
    });
  });
});
