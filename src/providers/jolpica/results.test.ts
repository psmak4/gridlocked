import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tests/helpers/fixtures";
import { parseJolpicaResults } from "./results";

function races(path: string) {
  return (
    readFixture(path) as {
      MRData: { RaceTable: { Races: Array<Record<string, unknown>> } };
    }
  ).MRData.RaceTable.Races[0]!;
}

/** The fixture with its result rows replaced by `edit(rows)`. */
function withRows(
  path: string,
  key: string,
  edit: (rows: Array<Record<string, unknown>>) => unknown,
) {
  const body = structuredClone(readFixture(path)) as {
    MRData: { RaceTable: { Races: Array<Record<string, unknown>> } };
  };
  const race = body.MRData.RaceTable.Races[0]!;
  race[key] = edit(race[key] as Array<Record<string, unknown>>);
  return body;
}

function ok(result: ReturnType<typeof parseJolpicaResults>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.problem}`);
  return result.rows;
}

describe("parseJolpicaResults: qualifying", () => {
  const body = readFixture("jolpica/2026/r18-qualifying.json");

  it("reads every row, in the official order", () => {
    const rows = ok(parseJolpicaResults("qualifying", body));
    expect(rows).toHaveLength(22);
    expect(rows.map((r) => r.position)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    expect(rows[0]).toMatchObject({
      driverKey: "antonelli",
      constructorKey: "mercedes",
      carNumber: 12,
      position: 1,
      classification: "classified",
      q1Ms: 95390,
      q2Ms: 94278,
      q3Ms: 94035,
      grid: null,
      pitLaneStart: false,
      laps: null,
      timeMs: null,
      officialPoints: null,
    });
  });

  it("treats an empty Q3 time as null, and keeps the position", () => {
    const rows = ok(parseJolpicaResults("qualifying", body));
    const lawson = rows.find((r) => r.driverKey === "lawson")!;
    expect(lawson.position).toBe(10);
    expect(lawson.q1Ms).toBe(95662);
    expect(lawson.q2Ms).toBe(95058);
    expect(lawson.q3Ms).toBeNull();
  });

  it("treats a missing time key like an empty one", () => {
    const rows = ok(parseJolpicaResults("qualifying", body));
    const gasly = rows.find((r) => r.driverKey === "gasly")!;
    expect(gasly.q3Ms).toBeNull();
    const knockedOutFirst = rows[21]!;
    expect(knockedOutFirst.q1Ms).toBe(97523);
    expect(knockedOutFirst.q2Ms).toBeNull();
    expect(knockedOutFirst.q3Ms).toBeNull();
  });

  it("keeps a driver listed with no times at all as classified, all null", () => {
    const edited = withRows(
      "jolpica/2026/r18-qualifying.json",
      "QualifyingResults",
      (rows) =>
        rows.map((r, i) =>
          i === 21 ? { ...r, Q1: "", Q2: undefined, Q3: undefined } : r,
        ),
    );
    const last = ok(parseJolpicaResults("qualifying", edited))[21]!;
    expect(last).toMatchObject({
      classification: "classified",
      q1Ms: null,
      q2Ms: null,
      q3Ms: null,
    });
  });

  it("reads a time with no minutes part", () => {
    const edited = withRows(
      "jolpica/2026/r18-qualifying.json",
      "QualifyingResults",
      (rows) => rows.map((r, i) => (i === 0 ? { ...r, Q1: "59.123" } : r)),
    );
    expect(ok(parseJolpicaResults("qualifying", edited))[0]!.q1Ms).toBe(59123);
  });

  it("fails on a time that is not m:ss.sss", () => {
    const edited = withRows(
      "jolpica/2026/r18-qualifying.json",
      "QualifyingResults",
      (rows) => rows.map((r, i) => (i === 0 ? { ...r, Q1: "fast" } : r)),
    );
    expect(parseJolpicaResults("qualifying", edited)).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });
});

describe("parseJolpicaResults: race", () => {
  it("reads the winner of round 1", () => {
    const rows = ok(
      parseJolpicaResults("race", readFixture("jolpica/2026/r01-results.json")),
    );
    expect(rows).toHaveLength(22);
    expect(rows[0]).toEqual({
      driverKey: "russell",
      constructorKey: "mercedes",
      carNumber: 63,
      position: 1,
      classification: "classified",
      providerStatus: "Finished",
      providerPositionText: "1",
      grid: 1,
      pitLaneStart: false,
      laps: 58,
      timeMs: 4986801,
      fastestLapRank: 6,
      fastestLapMs: 82670,
      q1Ms: null,
      q2Ms: null,
      q3Ms: null,
      officialPoints: "25.0",
    });
  });

  it("calls a retired driver with a numeric positionText classified", () => {
    // Round 12: classified, though the status says Retired.
    const rows = ok(
      parseJolpicaResults("race", readFixture("jolpica/2026/r12-results.json")),
    );
    const retired = rows.filter(
      (r) =>
        r.providerStatus === "Retired" && /^\d+$/.test(r.providerPositionText),
    );
    expect(retired).toHaveLength(1);
    expect(retired[0]!.classification).toBe("classified");
  });

  it("maps R to not_classified and W to did_not_start", () => {
    const rows = ok(
      parseJolpicaResults("race", readFixture("jolpica/2026/r01-results.json")),
    );
    const hulkenberg = rows.find((r) => r.driverKey === "hulkenberg")!;
    expect(hulkenberg).toMatchObject({
      position: 22,
      classification: "did_not_start",
      providerPositionText: "W",
      providerStatus: "Did not start",
      laps: 0,
      timeMs: null,
      fastestLapRank: null,
      fastestLapMs: null,
    });
    const r = ok(
      parseJolpicaResults("race", readFixture("jolpica/2026/r02-results.json")),
    );
    expect(
      r
        .filter((x) => x.providerPositionText === "R")
        .map((x) => x.classification),
    ).toSatisfy((all: string[]) => all.every((c) => c === "not_classified"));
  });

  it("maps D to disqualified (China 2025)", () => {
    const rows = ok(
      parseJolpicaResults("race", readFixture("jolpica/2025/r02-results.json")),
    );
    const dsq = rows.filter((r) => r.providerPositionText === "D");
    expect(dsq).toHaveLength(3);
    for (const r of dsq) expect(r.classification).toBe("disqualified");
    expect(dsq.map((r) => r.position)).toEqual([18, 19, 20]);
  });

  it("maps E to excluded, N to not_classified and F to did_not_qualify", () => {
    const edited = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      (rows) =>
        rows.map((r, i) =>
          i === 0
            ? { ...r, positionText: "E" }
            : i === 1
              ? { ...r, positionText: "N" }
              : i === 2
                ? { ...r, positionText: "F" }
                : r,
        ),
    );
    const rows = ok(parseJolpicaResults("race", edited));
    expect(rows.slice(0, 3).map((r) => r.classification)).toEqual([
      "excluded",
      "not_classified",
      "did_not_qualify",
    ]);
  });

  it("turns grid 0 into a pit-lane start with no grid slot", () => {
    const edited = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      (rows) => rows.map((r, i) => (i === 3 ? { ...r, grid: "0" } : r)),
    );
    const row = ok(parseJolpicaResults("race", edited))[3]!;
    expect(row.pitLaneStart).toBe(true);
    expect(row.grid).toBeNull();
    const normal = ok(parseJolpicaResults("race", edited))[4]!;
    expect(normal.pitLaneStart).toBe(false);
    expect(normal.grid).not.toBeNull();
  });

  it("fails with unknown_classification on a positionText we have no mapping for", () => {
    const edited = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      (rows) => rows.map((r, i) => (i === 5 ? { ...r, positionText: "Z" } : r)),
    );
    const result = parseJolpicaResults("race", edited);
    expect(result).toMatchObject({ ok: false, code: "unknown_classification" });
    expect(!result.ok && result.problem).toContain('"Z"');
  });

  it("fails when a required field is missing or malformed", () => {
    const noDriver = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      (rows) => rows.map((r, i) => (i === 0 ? { ...r, Driver: undefined } : r)),
    );
    expect(parseJolpicaResults("race", noDriver)).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
    const badLaps = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      (rows) => rows.map((r, i) => (i === 0 ? { ...r, laps: "many" } : r)),
    );
    expect(parseJolpicaResults("race", badLaps)).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });
});

describe("parseJolpicaResults: sprint", () => {
  it("reads sprint results from SprintResults", () => {
    const rows = ok(
      parseJolpicaResults(
        "sprint",
        readFixture("jolpica/2026/r02-sprint.json"),
      ),
    );
    expect(rows).toHaveLength(22);
    expect(rows[0]).toMatchObject({
      driverKey: "russell",
      position: 1,
      officialPoints: "8.0",
      timeMs: 2018998,
      fastestLapMs: 95101,
    });
    expect(rows[21]).toMatchObject({
      classification: "not_classified",
      timeMs: null,
      fastestLapRank: 18,
    });
  });
});

describe("parseJolpicaResults: a body we cannot use", () => {
  const body = readFixture("jolpica/2026/r01-results.json");

  it("fails when the results array is missing", () => {
    const edited = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      () => undefined,
    );
    expect(parseJolpicaResults("race", edited)).toEqual({
      ok: false,
      problem: "missing results",
      code: "validation_failed",
    });
  });

  it("fails when the body is not a Jolpica race table", () => {
    expect(parseJolpicaResults("race", {})).toMatchObject({
      ok: false,
      problem: "missing results",
    });
    expect(parseJolpicaResults("race", null)).toMatchObject({ ok: false });
  });

  it("fails when the body holds the other kind's results", () => {
    expect(parseJolpicaResults("sprint", body)).toMatchObject({
      ok: false,
      problem: "missing results",
    });
  });

  it("returns no rows for Jolpica's real not-published-yet answer (Races: [])", () => {
    const empty = readFixture("jolpica/2026/r23-results-empty.json");
    expect((empty as { MRData: { total: string } }).MRData.total).toBe("0");
    for (const kind of [
      "race",
      "sprint",
      "qualifying",
      "sprint_qualifying",
    ] as const) {
      expect(parseJolpicaResults(kind, empty)).toEqual({ ok: true, rows: [] });
    }
  });

  it("still fails for a present race with no results key", () => {
    const body = {
      MRData: { RaceTable: { Races: [{ season: "2026", round: "23" }] } },
    };
    expect(parseJolpicaResults("race", body)).toMatchObject({
      ok: false,
      problem: "missing results",
    });
  });

  it("returns no rows, not a failure, for an empty array", () => {
    const edited = withRows(
      "jolpica/2026/r01-results.json",
      "Results",
      () => [],
    );
    expect(parseJolpicaResults("race", edited)).toEqual({ ok: true, rows: [] });
  });

  it("has no results to parse for a practice session", () => {
    expect(parseJolpicaResults("fp1", body)).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });

  it("reads a race body only from its own key (races[0])", () => {
    expect(races("jolpica/2026/r01-results.json").round).toBe("1");
  });
});
