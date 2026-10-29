import { z } from "zod";
import type { Classification, ResultFacts, SessionKind } from "@/results/types";

// Jolpica's `/{year}/{round}/{results|sprint|qualifying}.json` -> our own
// shapes (DM 2.4). Nothing outside src/providers sees these key names.
//
// The parser has no database access, so it names the driver and constructor
// by their Jolpica keys. `normalizeJolpicaSession` maps them to our ids.

/** A parsed result, still keyed by Jolpica's driver and constructor ids. */
export interface JolpicaResultRow extends ResultFacts {
  driverKey: string;
  constructorKey: string;
}

export interface ParseFailure {
  ok: false;
  problem: string;
  code: "unknown_classification" | "validation_failed";
  /** Extra facts for the review item (see `checkRace`). */
  details?: Record<string, unknown>;
}

/**
 * What the request was for: the season and round we asked Jolpica about, and
 * the event's race date (`yyyy-mm-dd`, UTC) that the answer's `date` has to
 * be within `DATE_TOLERANCE_DAYS` of. Jolpica's date is the local race date
 * and ours is UTC, so they can differ by a day.
 */
export interface ExpectedRace {
  season: number;
  round: number;
  date: string | null;
}

const DATE_TOLERANCE_DAYS = 3;
const DAY_MS = 24 * 3_600_000;

export type JolpicaParse =
  { ok: true; rows: JolpicaResultRow[] } | ParseFailure;

/** The array under `MRData.RaceTable.Races[0]` that holds each kind's rows. */
const resultKeys: Partial<Record<SessionKind, string>> = {
  race: "Results",
  sprint: "SprintResults",
  qualifying: "QualifyingResults",
  sprint_qualifying: "SprintQualifyingResults",
};

const digits = z.string().regex(/^\d+$/);

const driverAndCar = {
  number: digits,
  Driver: z.object({ driverId: z.string().min(1) }),
  Constructor: z.object({ constructorId: z.string().min(1) }),
};

const raceRow = z.object({
  ...driverAndCar,
  position: digits,
  positionText: z.string(),
  points: z.string().regex(/^\d+(\.\d+)?$/),
  grid: digits,
  laps: digits,
  status: z.string(),
  Time: z
    .object({ millis: digits.optional(), time: z.string().optional() })
    .optional(),
  FastestLap: z
    .object({
      rank: digits.optional(),
      Time: z.object({ time: z.string().optional() }).optional(),
    })
    .optional(),
});

const qualifyingRow = z.object({
  ...driverAndCar,
  position: digits,
  Q1: z.string().optional(),
  Q2: z.string().optional(),
  Q3: z.string().optional(),
});

/** Our classification for a race or sprint `positionText`, or null (DM 2.4). */
function classify(positionText: string): Classification | null {
  if (/^\d+$/.test(positionText)) return "classified";
  switch (positionText) {
    case "R":
    case "N":
      return "not_classified";
    case "D":
      return "disqualified";
    case "E":
      return "excluded";
    case "W":
      return "did_not_start";
    case "F":
      return "did_not_qualify";
    default:
      return null;
  }
}

/** `m:ss.sss` (minutes optional) -> milliseconds, or null when it is not in that form. */
function lapTimeMs(text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2})\.(\d{3})$/.exec(text);
  if (!m) return null;
  return Number(m[1] ?? 0) * 60_000 + Number(m[2]) * 1000 + Number(m[3]);
}

const validationFailed = (problem: string): ParseFailure => ({
  ok: false,
  problem,
  code: "validation_failed",
});

function describeIssue(rowNumber: number, error: z.ZodError): string {
  const issue = error.issues[0]!;
  const path = issue.path.join(".") || "row";
  return `row ${rowNumber}: ${path}: ${issue.message}`;
}

/** The rows array for `kind`, or undefined when the body does not have one. */
function findRows(kind: SessionKind, body: unknown): unknown[] | undefined {
  const key = resultKeys[kind];
  if (key === undefined) return undefined;
  const parsed = z
    .object({
      MRData: z.object({
        RaceTable: z.object({
          Races: z.array(z.record(z.string(), z.unknown())),
        }),
      }),
    })
    .safeParse(body);
  if (!parsed.success) return undefined;
  const races = parsed.data.MRData.RaceTable.Races;
  // Jolpica's answer for a session that has no results yet is an empty race
  // list, not an error (recorded: tests/fixtures/jolpica/2026/r23-results-empty.json).
  if (races.length === 0) return [];
  const rows = races[0]![key];
  return Array.isArray(rows) ? rows : undefined;
}

function parseQualifyingRow(
  raw: unknown,
  rowNumber: number,
): JolpicaResultRow | ParseFailure {
  const row = qualifyingRow.safeParse(raw);
  if (!row.success)
    return validationFailed(describeIssue(rowNumber, row.error));
  const d = row.data;
  const times: Array<number | null> = [];
  for (const [name, text] of [
    ["Q1", d.Q1],
    ["Q2", d.Q2],
    ["Q3", d.Q3],
  ] as const) {
    // No time is null, whether the provider sends "" or leaves the key out.
    if (text === undefined || text === "") {
      times.push(null);
      continue;
    }
    const ms = lapTimeMs(text);
    if (ms === null) {
      return validationFailed(
        `row ${rowNumber}: ${name}: "${text}" is not m:ss.sss`,
      );
    }
    times.push(ms);
  }
  return {
    driverKey: d.Driver.driverId,
    constructorKey: d.Constructor.constructorId,
    carNumber: Number(d.number),
    position: Number(d.position),
    classification: "classified",
    // Qualifying rows carry neither; the columns are NOT NULL.
    providerStatus: "",
    providerPositionText: d.position,
    grid: null,
    pitLaneStart: false,
    laps: null,
    timeMs: null,
    fastestLapRank: null,
    fastestLapMs: null,
    q1Ms: times[0]!,
    q2Ms: times[1]!,
    q3Ms: times[2]!,
    officialPoints: null,
  };
}

function parseRaceRow(
  raw: unknown,
  rowNumber: number,
): JolpicaResultRow | ParseFailure {
  const row = raceRow.safeParse(raw);
  if (!row.success)
    return validationFailed(describeIssue(rowNumber, row.error));
  const d = row.data;
  const classification = classify(d.positionText);
  if (classification === null) {
    return {
      ok: false,
      problem: `row ${rowNumber}: unknown positionText "${d.positionText}" for ${d.Driver.driverId}`,
      code: "unknown_classification",
    };
  }
  let fastestLapMs: number | null = null;
  const lapText = d.FastestLap?.Time?.time;
  if (lapText !== undefined && lapText !== "") {
    fastestLapMs = lapTimeMs(lapText);
    if (fastestLapMs === null) {
      return validationFailed(
        `row ${rowNumber}: FastestLap.Time.time: "${lapText}" is not m:ss.sss`,
      );
    }
  }
  // Jolpica reports a pit-lane start as grid 0 (DM 2.4).
  const grid = Number(d.grid);
  return {
    driverKey: d.Driver.driverId,
    constructorKey: d.Constructor.constructorId,
    carNumber: Number(d.number),
    position: Number(d.position),
    classification,
    providerStatus: d.status,
    providerPositionText: d.positionText,
    grid: grid === 0 ? null : grid,
    pitLaneStart: grid === 0,
    laps: Number(d.laps),
    timeMs: d.Time?.millis === undefined ? null : Number(d.Time.millis),
    fastestLapRank:
      d.FastestLap?.rank === undefined ? null : Number(d.FastestLap.rank),
    fastestLapMs,
    q1Ms: null,
    q2Ms: null,
    q3Ms: null,
    officialPoints: Number(d.points).toFixed(1),
  };
}

/** A year, round or date as the body wrote it, or null when it is not there. */
const asNumber = (value: unknown): number | null => {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isNaN(n) ? null : n;
};
const asDate = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

/**
 * A body must be about the race we asked for. The answer for another season
 * or round (a stale cache, a wrong URL, a renumbered calendar) parses as
 * perfectly good results, so it is checked here: `Races[0]` has to carry our
 * season and round and a date near the event's. Returns the failure, or null.
 * An empty race list is "not published yet" and is not checked.
 */
function checkRace(body: unknown, expected: ExpectedRace): ParseFailure | null {
  const race = (body as { MRData?: { RaceTable?: { Races?: unknown } } } | null)
    ?.MRData?.RaceTable?.Races;
  if (!Array.isArray(race) || race.length === 0) return null;
  const first = race[0] as Record<string, unknown> | null;
  const got = {
    season: asNumber(first?.season),
    round: asNumber(first?.round),
    date: asDate(first?.date),
  };
  const dateOff =
    expected.date !== null &&
    (got.date === null ||
      Math.abs(
        Date.parse(`${got.date}T00:00:00Z`) -
          Date.parse(`${expected.date}T00:00:00Z`),
      ) >
        DATE_TOLERANCE_DAYS * DAY_MS);
  if (
    got.season === expected.season &&
    got.round === expected.round &&
    !dateOff
  ) {
    return null;
  }
  const show = (r: { season: unknown; round: unknown; date: unknown }) =>
    `${r.season ?? "?"} round ${r.round ?? "?"} (${r.date ?? "no date"})`;
  return {
    ok: false,
    code: "validation_failed",
    problem: `the answer is for ${show(got)}, not ${show(expected)}`,
    details: { asked: expected, got },
  };
}

/**
 * Reads one session's results out of a Jolpica response. A body that does not
 * have the expected array, a row that is not the shape we know, or a
 * `positionText` we have no mapping for fails the whole parse: no partial
 * rows, no guessed values. An empty array is not a failure (the results are
 * not out yet).
 *
 * With `expected`, a body whose `Races[0]` is for another season, round or
 * date fails too (see `checkRace`), with `details: { asked, got }`.
 */
export function parseJolpicaResults(
  kind: SessionKind,
  body: unknown,
  expected?: ExpectedRace,
): JolpicaParse {
  if (resultKeys[kind] === undefined) {
    return validationFailed(`${kind} sessions have no results to parse`);
  }
  const wrong = expected && checkRace(body, expected);
  if (wrong) return wrong;
  const raw = findRows(kind, body);
  if (raw === undefined) return validationFailed("missing results");

  const parseRow =
    kind === "qualifying" || kind === "sprint_qualifying"
      ? parseQualifyingRow
      : parseRaceRow;
  const rows: JolpicaResultRow[] = [];
  for (const [i, item] of raw.entries()) {
    const row = parseRow(item, i + 1);
    if ("ok" in row) return row;
    rows.push(row);
  }
  return { ok: true, rows };
}
