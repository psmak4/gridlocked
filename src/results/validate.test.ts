import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  rowsOf,
  sessionIdFor,
} from "../../tests/helpers/results-2026";
import { constructors, settings } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addOverride } from "./overrides";
import { validateSession, type Problem } from "./validate";

describe("validateSession", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const T0 = new Date("2026-10-04T08:00:00.000Z");
  const T1 = new Date("2026-10-04T09:00:00.000Z");
  const ADMIN = "0198f3e0-0000-7000-8000-0000000000aa";

  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  const kinds = (problems: Problem[]) => problems.map((p) => p.kind).sort();

  /** An override that edits the provider row of `driver` in `sessionId`. */
  async function patch(
    sessionId: string,
    driver: string,
    fields: Parameters<typeof addOverride>[2]["fields"],
  ) {
    await addOverride(t.db, T1, {
      sessionId,
      driverId: await idFor(t.db, "driver", driver),
      kind: "patch",
      fields,
      reason: "test",
      createdBy: ADMIN,
    });
  }

  describe("clean sessions", () => {
    it("round 18 race validates cleanly", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      expect(await validateSession(t.db, id)).toEqual([]);
    });

    it("round 18 qualifying validates cleanly", async () => {
      const id = await ingestRecorded(
        t.db,
        T0,
        18,
        "qualifying",
        "r18-qualifying.json",
      );
      expect(await validateSession(t.db, id)).toEqual([]);
    });

    it.each([
      [12, "r12-results.json"],
      [13, "r13-results.json"],
      [14, "r14-results.json"],
      [15, "r15-results.json"],
      [16, "r16-results.json"],
      [17, "r17-results.json"],
      [1, "r01-results.json"],
    ])(
      "round %i race (the substitute seats of DM 1.8 included) validates cleanly",
      async (round, file) => {
        const id = await ingestRecorded(t.db, T0, round, "race", file);
        expect(await validateSession(t.db, id)).toEqual([]);
      },
    );

    it("a practice session has nothing to validate", async () => {
      const id = await sessionIdFor(t.db, 18, "fp1");
      expect(await validateSession(t.db, id)).toEqual([]);
    });
  });

  describe("not yet complete", () => {
    it("no rows at all is incomplete", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      const problems = await validateSession(t.db, id);
      expect(problems).toEqual([
        {
          kind: "incomplete",
          severity: "warning",
          details: expect.objectContaining({ expected: 22, actual: 0 }),
        },
      ]);
    });

    it("fewer rows than entries is incomplete, not a missing driver", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const russell = await idFor(t.db, "driver", "russell");
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: russell,
        kind: "suppress",
        reason: "drop one",
        createdBy: ADMIN,
      });
      const problems = await validateSession(t.db, id);
      expect(problems).toEqual([
        {
          kind: "incomplete",
          severity: "warning",
          details: {
            expected: 22,
            actual: 21,
            missingDriverIds: [russell],
          },
        },
      ]);
    });
  });

  describe("roster surprises (HLD 8.2)", () => {
    it("a known driver in a different constructor is a team change", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await seedEntriesFor(t.db, id);
      const body = loadBody("jolpica/2026/r18-results.json");
      const row = rowsOf(body, "Results").find(
        (r) => (r.Driver as { driverId: string }).driverId === "russell",
      )!;
      (row.Constructor as { constructorId: string }).constructorId = "ferrari";
      await ingest(t.db, T0, id, "race", body);

      const problems = await validateSession(t.db, id);
      const mercedes = await idFor(t.db, "constructor", "mercedes");
      const ferrari = await idFor(t.db, "constructor", "ferrari");
      const russell = await idFor(t.db, "driver", "russell");
      expect(kinds(problems)).toEqual(["team_change", "too_many_cars"]);
      expect(problems.find((p) => p.kind === "team_change")).toEqual({
        kind: "team_change",
        severity: "blocking",
        details: {
          driverId: russell,
          constructorId: ferrari,
          expectedConstructorId: mercedes,
          carNumber: 63,
        },
      });
    });

    it("a driver with no entry is an unknown driver, and a third car is flagged", async () => {
      // Round 12: Hadjar has no race seat (Lawson took his Red Bull seat).
      const id = await ingestRecorded(t.db, T0, 12, "race", "r12-results.json");
      const hadjar = await idFor(t.db, "driver", "hadjar");
      const redBull = await idFor(t.db, "constructor", "red_bull");
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: hadjar,
        kind: "insert",
        fields: {
          constructor_id: redBull,
          car_number: 6,
          classification: "not_classified",
          provider_status: "Retired",
          provider_position_text: "R",
          position: 23,
          grid: 23,
        },
        reason: "test",
        createdBy: ADMIN,
      });
      const problems = await validateSession(t.db, id);
      expect(kinds(problems)).toEqual(["too_many_cars", "unknown_driver"]);
      expect(problems.find((p) => p.kind === "unknown_driver")).toEqual({
        kind: "unknown_driver",
        severity: "blocking",
        details: { driverId: hadjar, constructorId: redBull, carNumber: 6 },
      });
      expect(problems.find((p) => p.kind === "too_many_cars")).toMatchObject({
        severity: "blocking",
        details: { constructorId: redBull, cars: 3, allowed: 2 },
      });
    });

    it("a constructor the event has no entry for is unknown", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      const newTeam = newId();
      await t.db.insert(constructors).values({
        id: newTeam,
        slug: "new-team",
        name: "New Team",
        nationality: "n/a",
        createdAt: T0,
        updatedAt: T0,
      });
      await patch(id, "russell", { constructor_id: newTeam });
      const problems = await validateSession(t.db, id);
      expect(kinds(problems)).toEqual(["team_change", "unknown_constructor"]);
      expect(
        problems.find((p) => p.kind === "unknown_constructor")!.details,
      ).toMatchObject({ constructorId: newTeam });
    });

    it("an entered driver replaced by another is a missing driver once the count is met", async () => {
      const id = await ingestRecorded(t.db, T0, 12, "race", "r12-results.json");
      const lawson = await idFor(t.db, "driver", "lawson");
      const hadjar = await idFor(t.db, "driver", "hadjar");
      const redBull = await idFor(t.db, "constructor", "red_bull");
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: lawson,
        kind: "suppress",
        reason: "test",
        createdBy: ADMIN,
      });
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: hadjar,
        kind: "insert",
        fields: {
          constructor_id: redBull,
          car_number: 6,
          classification: "classified",
          provider_status: "Finished",
          provider_position_text: "11",
          position: 11,
          grid: 11,
        },
        reason: "test",
        createdBy: ADMIN,
      });
      const problems = await validateSession(t.db, id);
      expect(kinds(problems)).toContain("missing_driver");
      expect(kinds(problems)).toContain("unknown_driver");
      expect(kinds(problems)).not.toContain("incomplete");
      expect(
        problems.find((p) => p.kind === "missing_driver")!.details,
      ).toEqual({ driverId: lawson });
    });

    it("an event with no entries at all is one problem, not one per driver", async () => {
      const id = await sessionIdFor(t.db, 18, "race");
      await ingest(
        t.db,
        T0,
        id,
        "race",
        loadBody("jolpica/2026/r18-results.json"),
      );
      expect(await validateSession(t.db, id)).toEqual([
        { kind: "no_event_entries", severity: "blocking", details: {} },
      ]);
    });
  });

  describe("shape of the results", () => {
    it("classified positions that are not contiguous are flagged", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      // Second place moves to 5th: two cars on 5, nobody on 2.
      await patch(id, "russell", { position: 5 });
      const problems = await validateSession(t.db, id);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        kind: "positions_not_contiguous",
        severity: "blocking",
      });
    });

    it("a classified row without a position is flagged", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await patch(id, "antonelli", { position: null });
      expect(kinds(await validateSession(t.db, id))).toEqual([
        "positions_not_contiguous",
      ]);
    });

    it("a grid slot outside the field, or used twice, is implausible", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await patch(id, "antonelli", { grid: 40 });
      let problems = await validateSession(t.db, id);
      expect(kinds(problems)).toEqual(["implausible_grid"]);

      await patch(id, "antonelli", { grid: 2 });
      problems = await validateSession(t.db, id);
      expect(kinds(problems)).toEqual(["implausible_grid"]);
      expect(problems[0]!.details).toMatchObject({ duplicateGrids: [2] });
    });

    it("more than one fastest lap rank 1 is flagged", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      await patch(id, "antonelli", { fastest_lap_rank: 1 });
      await patch(id, "russell", { fastest_lap_rank: 1 });
      const problems = await validateSession(t.db, id);
      expect(kinds(problems)).toEqual(["multiple_fastest_laps"]);
    });
  });

  describe("settings and the effective layer", () => {
    it("the cars per constructor limit comes from validator_thresholds", async () => {
      const id = await ingestRecorded(t.db, T0, 12, "race", "r12-results.json");
      const hadjar = await idFor(t.db, "driver", "hadjar");
      const redBull = await idFor(t.db, "constructor", "red_bull");
      await addOverride(t.db, T1, {
        sessionId: id,
        driverId: hadjar,
        kind: "insert",
        fields: {
          constructor_id: redBull,
          car_number: 6,
          classification: "not_classified",
          provider_status: "Retired",
          provider_position_text: "R",
          position: 23,
          grid: 23,
        },
        reason: "test",
        createdBy: ADMIN,
      });
      await t.db.insert(settings).values({
        key: "validator_thresholds",
        value: { carsPerConstructor: 3 },
        updatedAt: T0,
      });
      expect(kinds(await validateSession(t.db, id))).toEqual([
        "unknown_driver",
      ]);
    });

    it("reads effective_results: a patch changes what is validated", async () => {
      const id = await ingestRecorded(t.db, T0, 18, "race", "r18-results.json");
      expect(await validateSession(t.db, id)).toEqual([]);
      await patch(id, "russell", {
        constructor_id: await idFor(t.db, "constructor", "ferrari"),
      });
      expect(kinds(await validateSession(t.db, id))).toContain("team_change");
    });

    it("counts cars per session, not per event", async () => {
      // Qualifying and race of one event both have 2 cars per team.
      const race = await ingestRecorded(
        t.db,
        T0,
        18,
        "race",
        "r18-results.json",
      );
      const quali = await ingestRecorded(
        t.db,
        T0,
        18,
        "qualifying",
        "r18-qualifying.json",
      );
      expect(await validateSession(t.db, race)).toEqual([]);
      expect(await validateSession(t.db, quali)).toEqual([]);
    });
  });
});
