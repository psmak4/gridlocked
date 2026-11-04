import { z } from "zod";
import type { Classification, SessionKind } from "@/results/types";

// The scoring rules as data (DM 3.2, HLD §5.6): the params each kind of
// calculation takes, and the 2026 game's rows. Pure: no database, no clock.
// The engine (`engine.ts`) reads these; nothing here knows how to score.

/**
 * The classifications a result row can have (DM 2.4). The list is repeated
 * here because `src/scoring` can't import the database schema; the check
 * below stops the two drifting apart.
 */
const CLASSIFICATIONS = [
  "classified",
  "not_classified",
  "disqualified",
  "did_not_start",
  "did_not_qualify",
  "excluded",
] as const satisfies readonly Classification[];
type _AllClassifications =
  Exclude<Classification, (typeof CLASSIFICATIONS)[number]> extends never
    ? true
    : never;
const _allClassifications: _AllClassifications = true;
void _allClassifications;

/** The sessions that score. Practice sessions never do. */
const SCORING_SESSION_KINDS = [
  "sprint_qualifying",
  "sprint",
  "qualifying",
  "race",
] as const satisfies readonly SessionKind[];

const classification = z.enum(CLASSIFICATIONS);
const points = z.number().int();

const positionTable = z.strictObject({
  /** Index 0 is P1; a position past the end scores 0. */
  points: z.array(points).min(1).max(10),
});
const positionsDelta = z.strictObject({
  perPosition: points,
  /** The most that can be lost, a negative number; null for no cap. */
  lostCap: points.max(0).nullable(),
});
const classificationPenalty = z.strictObject({
  points: points.max(0),
  classifications: z.array(classification),
  /** Also fires on a result with no Q1 time. */
  noTime: z.boolean(),
  /** Also fires on a pool driver with no result row. */
  absent: z.boolean(),
});
const flagBonus = z.strictObject({
  points,
  flag: z.literal("fastest_lap"),
});
const knockoutStage = z.strictObject({
  noneQ2: points,
  oneQ2: points,
  bothQ2: points,
  oneQ3: points,
  bothQ3: points,
});
const perDriverPenalty = z.strictObject({
  points: points.max(0),
  classifications: z.array(classification),
});
const aggregateDrivers = z.strictObject({});

const common = {
  /** Stable key such as `race.position`; score lines refer to it. */
  code: z.string().min(1),
  sessionKind: z.enum(SCORING_SESSION_KINDS),
  /** The category No Negative floors at 0 (HLD §5.4). */
  category: z.string().min(1),
  /** Order on the score explanation. */
  sortOrder: z.number().int(),
};

/** A kind that scores a driver. */
const forDriver = <K extends string, P extends z.ZodType>(kind: K, params: P) =>
  z.strictObject({
    ...common,
    target: z.literal("driver"),
    kind: z.literal(kind),
    params,
  });
/** A kind that scores a constructor, from its drivers' results. */
const forConstructor = <K extends string, P extends z.ZodType>(
  kind: K,
  params: P,
) =>
  z.strictObject({
    ...common,
    target: z.literal("constructor"),
    kind: z.literal(kind),
    params,
  });

/** One rule, its params checked for its kind and target. */
export const scoringRuleSchema = z.discriminatedUnion("kind", [
  forDriver("position_table", positionTable),
  forDriver("positions_delta", positionsDelta),
  forDriver("classification_penalty", classificationPenalty),
  forDriver("flag_bonus", flagBonus),
  forConstructor("knockout_stage", knockoutStage),
  forConstructor("per_driver_penalty", perDriverPenalty),
  forConstructor("aggregate_drivers", aggregateDrivers),
]);

export type ScoringRule = z.infer<typeof scoringRuleSchema>;

/** Not classified, did not start and excluded: the driver is not in the result. */
const NC = ["not_classified", "did_not_start", "excluded"] as const;

/** The 2026 game's rules, in the order they appear on a score explanation. */
export const SCORING_RULES_2026: ScoringRule[] = [
  {
    code: "qualifying.position",
    sessionKind: "qualifying",
    target: "driver",
    kind: "position_table",
    category: "qualifying_position",
    params: { points: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] },
    sortOrder: 10,
  },
  {
    code: "qualifying.not_classified",
    sessionKind: "qualifying",
    target: "driver",
    kind: "classification_penalty",
    category: "qualifying_penalty",
    params: {
      points: -5,
      classifications: [...NC, "did_not_qualify", "disqualified"],
      noTime: true,
      absent: true,
    },
    sortOrder: 20,
  },
  {
    code: "qualifying.drivers",
    sessionKind: "qualifying",
    target: "constructor",
    kind: "aggregate_drivers",
    category: "qualifying_drivers",
    params: {},
    sortOrder: 30,
  },
  {
    code: "qualifying.knockout",
    sessionKind: "qualifying",
    target: "constructor",
    kind: "knockout_stage",
    category: "qualifying_knockout",
    params: { noneQ2: -1, oneQ2: 1, bothQ2: 3, oneQ3: 5, bothQ3: 10 },
    sortOrder: 40,
  },
  {
    code: "qualifying.disqualified",
    sessionKind: "qualifying",
    target: "constructor",
    kind: "per_driver_penalty",
    category: "qualifying_penalty",
    params: { points: -5, classifications: ["disqualified"] },
    sortOrder: 50,
  },
  {
    code: "sprint.positions",
    sessionKind: "sprint",
    target: "driver",
    kind: "positions_delta",
    category: "sprint_positions",
    params: { perPosition: 1, lostCap: -10 },
    sortOrder: 10,
  },
  {
    code: "sprint.fastest_lap",
    sessionKind: "sprint",
    target: "driver",
    kind: "flag_bonus",
    category: "sprint_fastest_lap",
    params: { points: 5, flag: "fastest_lap" },
    sortOrder: 20,
  },
  {
    code: "sprint.position",
    sessionKind: "sprint",
    target: "driver",
    kind: "position_table",
    category: "sprint_position",
    params: { points: [8, 7, 6, 5, 4, 3, 2, 1] },
    sortOrder: 30,
  },
  {
    code: "sprint.not_classified",
    sessionKind: "sprint",
    target: "driver",
    kind: "classification_penalty",
    category: "sprint_penalty",
    params: {
      points: -10,
      classifications: [...NC, "disqualified"],
      noTime: false,
      absent: true,
    },
    sortOrder: 40,
  },
  {
    code: "sprint.drivers",
    sessionKind: "sprint",
    target: "constructor",
    kind: "aggregate_drivers",
    category: "sprint_drivers",
    params: {},
    sortOrder: 50,
  },
  {
    code: "sprint.disqualified",
    sessionKind: "sprint",
    target: "constructor",
    kind: "per_driver_penalty",
    category: "sprint_penalty",
    params: { points: -10, classifications: ["disqualified"] },
    sortOrder: 60,
  },
  {
    code: "race.positions",
    sessionKind: "race",
    target: "driver",
    kind: "positions_delta",
    category: "race_positions",
    params: { perPosition: 1, lostCap: null },
    sortOrder: 10,
  },
  {
    code: "race.fastest_lap",
    sessionKind: "race",
    target: "driver",
    kind: "flag_bonus",
    category: "race_fastest_lap",
    params: { points: 10, flag: "fastest_lap" },
    sortOrder: 20,
  },
  {
    code: "race.position",
    sessionKind: "race",
    target: "driver",
    kind: "position_table",
    category: "race_position",
    params: { points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] },
    sortOrder: 30,
  },
  {
    code: "race.not_classified",
    sessionKind: "race",
    target: "driver",
    kind: "classification_penalty",
    category: "race_penalty",
    params: {
      points: -20,
      classifications: [...NC, "disqualified"],
      noTime: false,
      absent: true,
    },
    sortOrder: 40,
  },
  {
    code: "race.drivers",
    sessionKind: "race",
    target: "constructor",
    kind: "aggregate_drivers",
    category: "race_drivers",
    params: {},
    sortOrder: 50,
  },
  {
    code: "race.disqualified",
    sessionKind: "race",
    target: "constructor",
    kind: "per_driver_penalty",
    category: "race_penalty",
    params: { points: -20, classifications: ["disqualified"] },
    sortOrder: 60,
  },
];
