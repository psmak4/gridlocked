import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  idFor,
  ingestWithSubstitute,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { auditLog, eventEntries } from "@/db/schema";
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
