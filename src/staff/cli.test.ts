import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  idFor,
  ingest,
  ingestWithSubstitute,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import {
  loadBody,
  rowsOf,
  sessionIdFor,
} from "../../tests/helpers/results-2026";
import {
  auditLog,
  effectiveResults,
  eventEntries,
  resultOverrides,
  reviewItems,
} from "@/db/schema";
import { advanceStatus } from "@/results/status";
import { parseStaffEnv, runStaffCommand } from "./cli";

const T0 = new Date("2026-10-04T08:00:00.000Z");
const T1 = new Date("2026-10-04T09:00:00.000Z");

const ENV = {
  STAFF_EVENT: "2026/18",
  STAFF_CHANGE: JSON.stringify({
    in: "tsunoda",
    team: "haas",
    car: 22,
    out: "ocon",
  }),
  STAFF_REASON: "Tsunoda replaces Ocon from FP3",
  STAFF_ACTOR: "psmak4",
  STAFF_REQUEST_ID: "gh-run:1",
  STAFF_DRY_RUN: "false",
};

describe("pnpm staff", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let eventId: string;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    const r = await ingestWithSubstitute(
      t.db,
      T0,
      18,
      "race",
      "r18-results.json",
      {
        replaced: "ocon",
        sub: "tsunoda",
        constructorKey: "haas",
        car: 22,
        enter: false,
      },
    );
    await advanceStatus(t.db, T0, r.sessionId);
    eventId = r.eventId;
  });
  afterEach(async () => {
    await t.close();
  });

  const entries = () =>
    t.db.select().from(eventEntries).where(eq(eventEntries.eventId, eventId));

  it("a dry run resolves the keys and writes nothing", async () => {
    const before = await entries();
    const cmd = parseStaffEnv("substitute", { ...ENV, STAFF_DRY_RUN: "true" });
    const report = await runStaffCommand(t.db, T1, cmd);
    expect(report).toMatchObject({
      dryRun: true,
      command: "substitute",
      resolved: {
        eventId,
        inDriverId: await idFor(t.db, "driver", "tsunoda"),
        constructorId: await idFor(t.db, "constructor", "haas"),
        outDriverId: await idFor(t.db, "driver", "ocon"),
        carNumber: 22,
      },
    });
    expect(await entries()).toEqual(before);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it.each([
    [
      "an unknown driver key",
      {
        STAFF_CHANGE: JSON.stringify({
          in: "nobody",
          team: "haas",
          car: 22,
          out: null,
        }),
      },
      /no driver nobody/,
    ],
    ["malformed JSON", { STAFF_CHANGE: "{in: tsunoda" }, /STAFF_CHANGE/],
    ["a missing actor", { STAFF_ACTOR: "" }, /STAFF_ACTOR/],
    ["a blank reason", { STAFF_REASON: "   " }, /STAFF_REASON/],
    ["an unknown event", { STAFF_EVENT: "2026/99" }, /no event 2026\/99/],
  ])("%s is refused before any write", async (_, over, error) => {
    const before = await entries();
    await expect(
      (async () =>
        runStaffCommand(
          t.db,
          T1,
          parseStaffEnv("substitute", { ...ENV, ...over }),
        ))(),
    ).rejects.toThrow(error);
    expect(await entries()).toEqual(before);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it("refuses an unknown command", () => {
    expect(() => parseStaffEnv("delete-everything", ENV)).toThrow(/command/);
  });

  it("a real run records the substitution and prints the session moves", async () => {
    const report = await runStaffCommand(
      t.db,
      T1,
      parseStaffEnv("substitute", ENV),
    );
    expect(report).toMatchObject({
      dryRun: false,
      changed: true,
      sessions: [
        { kind: "race", previous: "under_review", next: "provisional" },
      ],
    });
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorLabel: "psmak4",
      requestId: "gh-run:1",
    });
  });

  it("a seats run resolves each change", async () => {
    const cmd = parseStaffEnv("seats", {
      ...ENV,
      STAFF_EVENT: "2026/20",
      STAFF_CHANGE: JSON.stringify([
        { driver: "ocon", team: null },
        { driver: "tsunoda", team: "haas", car: 22 },
      ]),
      STAFF_DRY_RUN: "true",
    });
    const report = await runStaffCommand(t.db, T1, cmd);
    expect(report).toMatchObject({
      dryRun: true,
      command: "seats",
      resolved: {
        changes: [
          {
            driverId: await idFor(t.db, "driver", "ocon"),
            constructorId: null,
          },
          {
            driverId: await idFor(t.db, "driver", "tsunoda"),
            constructorId: await idFor(t.db, "constructor", "haas"),
            carNumber: 22,
          },
        ],
      },
    });
  });
});

describe("pnpm staff override", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let sessionId: string;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
    sessionId = await sessionIdFor(t.db, 18, "qualifying");
    await seedEntriesFor(t.db, sessionId);
    // Mexico 2026's shape: the disqualified driver keeps P8, and everyone
    // below moves up one, so two drivers say 8 and nobody says 22.
    const body = loadBody("jolpica/2026/r18-qualifying.json");
    for (const r of rowsOf(body, "QualifyingResults")) {
      const p = Number(r.position);
      if (p > 8) r.position = String(p - 1);
    }
    await ingest(t.db, T0, sessionId, "qualifying", body);
    await advanceStatus(t.db, T0, sessionId);
  });
  afterEach(async () => {
    await t.close();
  });

  const OVERRIDE = {
    ...ENV,
    STAFF_CHANGE: JSON.stringify({
      session: "qualifying",
      driver: "norris",
      fields: { classification: "disqualified", position: null },
    }),
    STAFF_REASON: "Disqualified from qualifying (stewards' decision)",
  };
  const items = () =>
    t.db
      .select({ status: reviewItems.status, kind: reviewItems.kind })
      .from(reviewItems)
      .where(eq(reviewItems.sessionId, sessionId));

  it("a dry run resolves the session and driver and writes nothing", async () => {
    const report = await runStaffCommand(
      t.db,
      T1,
      parseStaffEnv("override", { ...OVERRIDE, STAFF_DRY_RUN: "true" }),
    );
    expect(report).toMatchObject({
      dryRun: true,
      command: "override",
      resolved: {
        sessionId,
        driverId: await idFor(t.db, "driver", "norris"),
        fields: { classification: "disqualified", position: null },
      },
    });
    expect(await t.db.select().from(resultOverrides)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it("a real run patches the row, audits it, and moves the session", async () => {
    expect(await items()).toEqual([
      { status: "open", kind: "validation_failed" },
    ]);
    const report = await runStaffCommand(
      t.db,
      T1,
      parseStaffEnv("override", OVERRIDE),
    );
    expect(report).toMatchObject({
      dryRun: false,
      changed: true,
      sessions: [
        { kind: "qualifying", previous: "under_review", next: "provisional" },
      ],
    });
    const norris = await idFor(t.db, "driver", "norris");
    const [row] = await t.db
      .select()
      .from(effectiveResults)
      .where(
        and(
          eq(effectiveResults.sessionId, sessionId),
          eq(effectiveResults.driverId, norris),
        ),
      );
    expect(row).toMatchObject({
      classification: "disqualified",
      position: null,
      overridden: true,
      overrideReason: OVERRIDE.STAFF_REASON,
    });
    expect(await items()).toEqual([
      { status: "resolved", kind: "validation_failed" },
    ]);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "result_override.create",
      entityType: "result_override",
      actorKind: "admin",
      actorLabel: "psmak4",
      requestId: "gh-run:1",
      reason: OVERRIDE.STAFF_REASON,
      before: null,
      after: {
        sessionId,
        driverId: norris,
        kind: "patch",
        fields: { classification: "disqualified", position: null },
      },
    });
  });

  it("running it again changes nothing and writes no audit row", async () => {
    await runStaffCommand(t.db, T1, parseStaffEnv("override", OVERRIDE));
    const again = await runStaffCommand(
      t.db,
      T1,
      parseStaffEnv("override", OVERRIDE),
    );
    expect(again).toMatchObject({ dryRun: false, changed: false });
    expect(await t.db.select().from(resultOverrides)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it.each([
    [
      "a field results does not have",
      { fields: { team: "haas" } },
      /STAFF_CHANGE/,
    ],
    ["no fields", { fields: {} }, /STAFF_CHANGE/],
    ["a session kind that is not scored", { session: "fp1" }, /STAFF_CHANGE/],
  ])("%s is refused before any write", (_, over, error) => {
    const change = {
      session: "qualifying",
      driver: "norris",
      fields: { classification: "disqualified" },
      ...over,
    };
    expect(() =>
      parseStaffEnv("override", {
        ...OVERRIDE,
        STAFF_CHANGE: JSON.stringify(change),
      }),
    ).toThrow(error);
  });

  it("a driver with no result in the session is refused before any write", async () => {
    await expect(
      runStaffCommand(
        t.db,
        T1,
        parseStaffEnv("override", {
          ...OVERRIDE,
          STAFF_CHANGE: JSON.stringify({
            session: "qualifying",
            driver: "tsunoda",
            fields: { classification: "disqualified" },
          }),
        }),
      ),
    ).rejects.toThrow(/no qualifying result for tsunoda|has no result/);
    expect(await t.db.select().from(resultOverrides)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it("a session the event does not have is refused before any write", async () => {
    await expect(
      runStaffCommand(
        t.db,
        T1,
        parseStaffEnv("override", {
          ...OVERRIDE,
          STAFF_CHANGE: JSON.stringify({
            session: "sprint",
            driver: "norris",
            fields: { classification: "disqualified" },
          }),
        }),
      ),
    ).rejects.toThrow(/no sprint session at 2026\/18/);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});
