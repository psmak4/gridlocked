import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  sessionIdFor,
  storeResultsSnapshot,
} from "../../tests/helpers/results-2026";
import {
  idFor,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import {
  eventEntries,
  events,
  reviewItems,
  sessionParticipants,
} from "@/db/schema";
import { rosterCheck } from "./roster-check";

const NOW = new Date("2026-09-05T12:00:00.000Z");

describe("rosterCheck", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let eventId: string;
  let fp1: string;
  let fp2: string;
  let fp3: string;

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    fp1 = await sessionIdFor(t.db, 13, "fp1");
    fp2 = await sessionIdFor(t.db, 13, "fp2");
    fp3 = await sessionIdFor(t.db, 13, "fp3");
    eventId = await seedEntriesFor(t.db, fp2);
  });
  afterEach(async () => {
    await t.close();
  });

  const entries = () =>
    t.db.select().from(eventEntries).where(eq(eventEntries.eventId, eventId));

  /** Participants for a session: the entries, less `skip`, plus `extra`. */
  async function participate(
    sessionId: string,
    opts: {
      skip?: string[];
      extra?: Array<{ driverId: string; constructorId: string }>;
      move?: Record<string, string>;
    } = {},
  ) {
    const snapshotId = await storeResultsSnapshot(t.db, NOW, sessionId, {
      for: sessionId,
    });
    const rows = (await entries())
      .filter((e) => !opts.skip?.includes(e.driverId))
      .map((e) => ({
        driverId: e.driverId,
        constructorId: opts.move?.[e.driverId] ?? e.constructorId,
      }));
    await t.db.insert(sessionParticipants).values(
      [...rows, ...(opts.extra ?? [])].map((r) => ({
        sessionId,
        ...r,
        provider: "openf1",
        snapshotId,
      })),
    );
  }

  const items = () =>
    t.db.select().from(reviewItems).where(eq(reviewItems.eventId, eventId));

  it("opens nothing when FP2 and FP3 match the entries", async () => {
    await participate(fp2);
    await participate(fp3);
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("opens nothing when there are no participants yet", async () => {
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("opens one team_change warning for a substitute, once across reruns", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    await participate(fp2);
    await participate(fp3, { extra: [{ driverId: herta, constructorId: rb }] });

    const problems = await rosterCheck(t.db, NOW, eventId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "team_change",
      severity: "warning",
      details: {
        driverId: herta,
        constructorId: rb,
        expectedConstructorId: null,
      },
    });

    await rosterCheck(t.db, NOW, eventId);
    await rosterCheck(t.db, NOW, eventId);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "team_change",
      severity: "warning",
      status: "open",
      driverId: herta,
      sessionId: fp3,
      dedupeKey: `roster:${eventId}:team_change:${herta}`,
    });
  });

  it("opens a team_change warning for an entered driver in another team", async () => {
    const lawson = await idFor(t.db, "driver", "lawson");
    const redBull = await idFor(t.db, "constructor", "red_bull");
    const rb = await idFor(t.db, "constructor", "rb");
    const entry = (await entries()).find((e) => e.driverId === lawson)!;
    expect(entry.constructorId).toBe(redBull);

    await participate(fp2, { move: { [lawson]: rb } });
    await participate(fp3);

    const problems = await rosterCheck(t.db, NOW, eventId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "team_change",
      details: {
        driverId: lawson,
        constructorId: rb,
        expectedConstructorId: redBull,
      },
    });
    const open = await items();
    expect(open.map((i) => i.dedupeKey)).toEqual([
      `roster:${eventId}:team_change:${lawson}`,
    ]);
  });

  it("opens a missing_driver warning for a driver absent from FP2 and FP3", async () => {
    const stroll = await idFor(t.db, "driver", "stroll");
    await participate(fp2, { skip: [stroll] });
    await participate(fp3, { skip: [stroll] });

    const problems = await rosterCheck(t.db, NOW, eventId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "missing_driver",
      severity: "warning",
      details: { driverId: stroll },
    });
    await rosterCheck(t.db, NOW, eventId);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "missing_driver",
      severity: "warning",
      driverId: stroll,
      dedupeKey: `roster:${eventId}:missing:${stroll}`,
    });
  });

  it("a driver absent from FP2 but present in FP3 is not missing", async () => {
    const stroll = await idFor(t.db, "driver", "stroll");
    await participate(fp2, { skip: [stroll] });
    await participate(fp3);
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
  });

  it("a driver who ran FP2 but not FP3 is missing", async () => {
    // Mexico City 2026: Ocon ran FP2, then Hirakawa took his car from FP3.
    const stroll = await idFor(t.db, "driver", "stroll");
    await participate(fp2);
    await participate(fp3, { skip: [stroll] });
    const problems = await rosterCheck(t.db, NOW, eventId);
    expect(problems).toEqual([
      expect.objectContaining({
        kind: "missing_driver",
        details: expect.objectContaining({ driverId: stroll }),
      }),
    ]);
  });

  it("after a recorded substitution, the replaced driver is not missing", async () => {
    // Hadjar has no race seat at round 13; he stands in for Stroll from FP3.
    const stroll = await idFor(t.db, "driver", "stroll");
    const hadjar = await idFor(t.db, "driver", "hadjar");
    const aston = await idFor(t.db, "constructor", "aston_martin");
    await t.db.insert(eventEntries).values({
      eventId,
      driverId: hadjar,
      constructorId: aston,
      carNumber: 6,
      source: "admin",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await participate(fp2, { skip: [hadjar] });
    await participate(fp3, { skip: [stroll] });
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
  });

  it("judges by FP2 alone before FP3 has participants", async () => {
    const stroll = await idFor(t.db, "driver", "stroll");
    await participate(fp2, { skip: [stroll] });
    const problems = await rosterCheck(t.db, NOW, eventId);
    expect(problems.map((p) => p.kind)).toEqual(["missing_driver"]);
  });

  it("opens nothing for an FP1-only young driver", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    const stroll = await idFor(t.db, "driver", "stroll");
    await participate(fp1, {
      skip: [stroll],
      extra: [{ driverId: herta, constructorId: rb }],
    });
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("ignores an FP1 substitute once FP2 and FP3 are clean", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    await participate(fp1, { extra: [{ driverId: herta, constructorId: rb }] });
    await participate(fp2);
    await participate(fp3);
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
  });

  /** Sets every item of the event to `status` (an admin's decision). */
  const decide = (status: "resolved" | "dismissed") =>
    t.db
      .update(reviewItems)
      .set({ status, resolution: "admin decided" })
      .where(eq(reviewItems.eventId, eventId));

  it("does not ask again about a finding an admin already decided", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    await participate(fp2, { extra: [{ driverId: herta, constructorId: rb }] });
    await rosterCheck(t.db, NOW, eventId);
    await decide("dismissed");
    await rosterCheck(t.db, NOW, eventId);
    expect((await items()).map((i) => i.status)).toEqual(["dismissed"]);

    await decide("resolved");
    await rosterCheck(t.db, NOW, eventId);
    expect((await items()).map((i) => i.status)).toEqual(["resolved"]);
  });

  it("asks again when the decided finding has changed", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    const mclaren = await idFor(t.db, "constructor", "mclaren");
    await participate(fp2, { extra: [{ driverId: herta, constructorId: rb }] });
    await rosterCheck(t.db, NOW, eventId);
    await decide("dismissed");
    await t.db
      .update(sessionParticipants)
      .set({ constructorId: mclaren })
      .where(
        and(
          eq(sessionParticipants.sessionId, fp2),
          eq(sessionParticipants.driverId, herta),
        ),
      );
    await rosterCheck(t.db, NOW, eventId);
    expect((await items()).map((i) => i.status).sort()).toEqual([
      "dismissed",
      "open",
    ]);
  });

  it("resolves a missing_driver warning once the driver turns up", async () => {
    const stroll = await idFor(t.db, "driver", "stroll");
    const aston = await idFor(t.db, "constructor", "aston_martin");
    await participate(fp2, { skip: [stroll] });
    await rosterCheck(t.db, NOW, eventId);
    expect((await items()).map((i) => i.status)).toEqual(["open"]);

    const [row] = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, fp2))
      .limit(1);
    await t.db.insert(sessionParticipants).values({
      ...row!,
      driverId: stroll,
      constructorId: aston,
    });
    const later = new Date("2026-09-05T13:00:00.000Z");
    expect(await rosterCheck(t.db, later, eventId)).toEqual([]);

    const [item] = await items();
    expect(item).toMatchObject({
      status: "resolved",
      resolution: "auto: no longer detected",
      resolvedAt: later,
    });

    // If it goes missing again, that is a new finding.
    await t.db
      .delete(sessionParticipants)
      .where(eq(sessionParticipants.driverId, stroll));
    await rosterCheck(t.db, later, eventId);
    expect((await items()).map((i) => i.status).sort()).toEqual([
      "open",
      "resolved",
    ]);
  });

  it("resolves a team_change warning that no longer applies", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    await participate(fp2, { extra: [{ driverId: herta, constructorId: rb }] });
    await rosterCheck(t.db, NOW, eventId);

    // An admin adds him to the entries: the substitute is now expected.
    await t.db.insert(eventEntries).values({
      eventId,
      driverId: herta,
      constructorId: rb,
      carNumber: 98,
      source: "admin",
    });
    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
    expect(await items()).toMatchObject([
      { status: "resolved", resolution: "auto: no longer detected" },
    ]);
  });

  it("keeps the details of an open item fresh", async () => {
    const herta = await idFor(t.db, "driver", "colton_herta");
    const rb = await idFor(t.db, "constructor", "rb");
    const mclaren = await idFor(t.db, "constructor", "mclaren");
    await participate(fp2, { extra: [{ driverId: herta, constructorId: rb }] });
    await rosterCheck(t.db, NOW, eventId);
    await t.db
      .update(sessionParticipants)
      .set({ constructorId: mclaren })
      .where(eq(sessionParticipants.driverId, herta));
    await rosterCheck(t.db, NOW, eventId);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]!.details).toMatchObject({ constructorId: mclaren });
  });

  it("throws for an event that does not exist", async () => {
    const [other] = await t.db.select().from(events).limit(1);
    expect(other).toBeDefined();
    await expect(
      rosterCheck(t.db, NOW, "00000000-0000-7000-8000-000000000000"),
    ).rejects.toThrow();
  });
});
