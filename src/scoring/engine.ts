import type { Classification } from "@/results/types";
import type { ScoringRule } from "./rules";

// The scoring engine (DM 4.2, HLD §5.6): a session's rules and results in, the
// score lines of every pool asset out. Pure: no database, no clock, and the
// same input always gives the same lines in the same order.

/** The subset of an effective result the engine reads. */
export interface ResultFact {
  driverId: string;
  constructorId: string;
  position: number | null;
  classification: Classification;
  grid: number | null;
  pitLaneStart: boolean;
  fastestLapRank: number | null;
  q1Ms: number | null;
}

/**
 * A pool asset added at or before the event, withdrawn ones included: the
 * owners of a withdrawn asset still take its penalties (DM 3.4).
 */
export interface PoolEntry {
  assetId: string;
  assetType: "driver" | "constructor";
  driverId: string | null;
  constructorId: string | null;
}

export interface SessionInput {
  sessionKind: "qualifying" | "sprint" | "race";
  rules: ScoringRule[];
  /** A driver reached Q2 at this position or better, and Q3 at that one. */
  knockout: { q2From: number; q3From: number };
  results: ResultFact[];
  pool: PoolEntry[];
}

/** One scored line on one asset. `points` is never 0. */
export interface AssetLine {
  assetId: string;
  ruleCode: string;
  category: string;
  /** The driver a constructor line came from; null on a driver's own lines. */
  subjectDriverId: string | null;
  points: number;
  /** Why the line scored, for the score explanation. */
  detail: Record<string, unknown>;
}

type DriverRule = Extract<ScoringRule, { target: "driver" }>;
type ConstructorRule = Extract<ScoringRule, { target: "constructor" }>;

/** What a rule scored, before it belongs to an asset. */
interface Scored {
  points: number;
  detail: Record<string, unknown>;
}

/** A constructor line's source: the driver it came from, or null for its own. */
interface ConstructorScored extends Scored {
  rule: ScoringRule;
  subjectDriverId: string | null;
}

interface Context {
  knockout: SessionInput["knockout"];
  /** How many cars started: the grid slot of a pit-lane start. */
  rowCount: number;
}

function assertNever(value: never): never {
  throw new Error(`unhandled scoring rule: ${JSON.stringify(value)}`);
}

const isDriverRule = (rule: ScoringRule): rule is DriverRule =>
  rule.target === "driver";
const isConstructorRule = (rule: ScoringRule): rule is ConstructorRule =>
  rule.target === "constructor";

/** Positions score only for a driver who finished the session classified. */
function classifiedPosition(row: ResultFact): number | null {
  return row.classification === "classified" ? row.position : null;
}

function positionTable(
  params: Extract<DriverRule, { kind: "position_table" }>["params"],
  row: ResultFact,
): Scored | null {
  const position = classifiedPosition(row);
  if (position === null) return null;
  return { points: params.points[position - 1] ?? 0, detail: { position } };
}

function positionsDelta(
  params: Extract<DriverRule, { kind: "positions_delta" }>["params"],
  row: ResultFact,
  context: Context,
): Scored | null {
  const position = classifiedPosition(row);
  const grid = row.pitLaneStart ? context.rowCount : row.grid;
  if (position === null || grid === null) return null;
  const gained = (grid - position) * params.perPosition;
  const points =
    params.lostCap === null ? gained : Math.max(gained, params.lostCap);
  return { points, detail: { grid, position } };
}

function classificationPenalty(
  params: Extract<DriverRule, { kind: "classification_penalty" }>["params"],
  row: ResultFact | null,
): Scored | null {
  if (row === null) {
    return params.absent
      ? { points: params.points, detail: { reason: "absent" } }
      : null;
  }
  // One penalty however many of the conditions the row meets.
  if (params.classifications.includes(row.classification)) {
    return {
      points: params.points,
      detail: { classification: row.classification },
    };
  }
  if (params.noTime && row.q1Ms === null) {
    return { points: params.points, detail: { reason: "no_time" } };
  }
  return null;
}

function flagBonus(
  params: Extract<DriverRule, { kind: "flag_bonus" }>["params"],
  row: ResultFact,
): Scored | null {
  if (classifiedPosition(row) === null || row.fastestLapRank !== 1) return null;
  return { points: params.points, detail: { flag: params.flag } };
}

/** A driver rule on a driver's result; null when the driver has no row. */
function scoreDriverRule(
  rule: DriverRule,
  row: ResultFact | null,
  context: Context,
): Scored | null {
  switch (rule.kind) {
    case "classification_penalty":
      return classificationPenalty(rule.params, row);
    case "position_table":
      return row && positionTable(rule.params, row);
    case "positions_delta":
      return row && positionsDelta(rule.params, row, context);
    case "flag_bonus":
      return row && flagBonus(rule.params, row);
    default:
      return assertNever(rule);
  }
}

/** The best tier a constructor's drivers reached; only that one scores. */
function knockoutStage(
  params: Extract<ConstructorRule, { kind: "knockout_stage" }>["params"],
  rows: ResultFact[],
  context: Context,
): Scored {
  const reached = (from: number) =>
    rows.filter((r) => r.position !== null && r.position <= from).length;
  const q3 = reached(context.knockout.q3From);
  const q2 = reached(context.knockout.q2From);
  const [tier, points] =
    q3 >= 2
      ? (["bothQ3", params.bothQ3] as const)
      : q3 === 1
        ? (["oneQ3", params.oneQ3] as const)
        : q2 >= 2
          ? (["bothQ2", params.bothQ2] as const)
          : q2 === 1
            ? (["oneQ2", params.oneQ2] as const)
            : (["noneQ2", params.noneQ2] as const);
  return { points, detail: { tier } };
}

/** A penalty on the constructor for each of its drivers with a listed result. */
function perDriverPenalty(
  params: Extract<ConstructorRule, { kind: "per_driver_penalty" }>["params"],
  rows: ResultFact[],
): { driverId: string; scored: Scored }[] {
  return rows
    .filter((r) => params.classifications.includes(r.classification))
    .map((r) => ({
      driverId: r.driverId,
      scored: {
        points: params.points,
        detail: { classification: r.classification },
      },
    }));
}

/**
 * A constructor's own rules over its drivers' rows. `aggregate_drivers` passes
 * the driver rules through: each driver's lines are copied under the
 * constructor, as the driver rule's own code and category with that driver as
 * the subject, so the explanation shows who earned what.
 */
function scoreConstructorRule(
  rule: ConstructorRule,
  rows: ResultFact[],
  driverRules: DriverRule[],
  context: Context,
): ConstructorScored[] {
  switch (rule.kind) {
    case "aggregate_drivers":
      return rows.flatMap((row) =>
        driverRules.flatMap((driverRule) => {
          const scored = scoreDriverRule(driverRule, row, context);
          return scored
            ? [{ rule: driverRule, subjectDriverId: row.driverId, ...scored }]
            : [];
        }),
      );
    case "knockout_stage":
      // A constructor with no driver in the session has no stage to score.
      return rows.length === 0
        ? []
        : [
            {
              rule,
              subjectDriverId: null,
              ...knockoutStage(rule.params, rows, context),
            },
          ];
    case "per_driver_penalty":
      return perDriverPenalty(rule.params, rows).map((p) => ({
        rule,
        subjectDriverId: p.driverId,
        ...p.scored,
      }));
    default:
      return assertNever(rule);
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Scores one session. Every driver in the results is scored, in the pool or
 * not, because a substitute's points are his constructor's. A pool driver
 * with no result row takes only the `absent` penalties and adds nothing to a
 * constructor.
 */
export function scoreSession(input: SessionInput): AssetLine[] {
  const rules = input.rules.filter((r) => r.sessionKind === input.sessionKind);
  const driverRules = rules.filter(isDriverRule);
  const constructorRules = rules.filter(isConstructorRule);
  const context: Context = {
    knockout: input.knockout,
    rowCount: input.results.length,
  };

  const rowByDriver = new Map(input.results.map((r) => [r.driverId, r]));
  const rowsByConstructor = new Map<string, ResultFact[]>();
  for (const row of input.results) {
    const rows = rowsByConstructor.get(row.constructorId) ?? [];
    rows.push(row);
    rowsByConstructor.set(row.constructorId, rows);
  }

  const lines: { sortOrder: number; line: AssetLine }[] = [];
  for (const entry of input.pool) {
    if (entry.assetType === "driver") {
      if (entry.driverId === null) continue;
      const row = rowByDriver.get(entry.driverId) ?? null;
      for (const rule of driverRules) {
        const scored = scoreDriverRule(rule, row, context);
        if (scored) {
          lines.push(scoredLine(entry.assetId, rule, null, scored));
        }
      }
    } else {
      if (entry.constructorId === null) continue;
      const rows = rowsByConstructor.get(entry.constructorId) ?? [];
      for (const rule of constructorRules) {
        for (const scored of scoreConstructorRule(
          rule,
          rows,
          driverRules,
          context,
        )) {
          lines.push(
            scoredLine(
              entry.assetId,
              scored.rule,
              scored.subjectDriverId,
              scored,
            ),
          );
        }
      }
    }
  }

  return lines
    .filter((l) => l.line.points !== 0)
    .sort(
      (a, b) =>
        compare(a.line.assetId, b.line.assetId) ||
        a.sortOrder - b.sortOrder ||
        compare(a.line.subjectDriverId ?? "", b.line.subjectDriverId ?? "") ||
        compare(a.line.ruleCode, b.line.ruleCode),
    )
    .map((l) => l.line);
}

function scoredLine(
  assetId: string,
  rule: ScoringRule,
  subjectDriverId: string | null,
  scored: Scored,
): { sortOrder: number; line: AssetLine } {
  return {
    sortOrder: rule.sortOrder,
    line: {
      assetId,
      ruleCode: rule.code,
      category: rule.category,
      subjectDriverId,
      points: scored.points,
      detail: scored.detail,
    },
  };
}
