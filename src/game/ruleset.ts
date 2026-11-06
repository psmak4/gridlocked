import { z } from "zod";

// The ruleset parameters (DM 3.2): everything about the game that isn't a
// scoring rule. They are read together, never searched, so they live in
// `ruleset_versions.params` as jsonb and are checked here. Every object is
// strict: a misspelt key is an error, not a silently ignored setting.
//
// Money is an integer count of $0.1M (DM 0.3, `MoneyUnits`).

export const CHIP_UNLOCKS = ["from_start", "after_first_event"] as const;
/** What the engine does for a chip; the code is how the ruleset names it. */
export const CHIP_EFFECTS = [
  "autopilot",
  "triple_boost",
  "no_negative",
  "wildcard",
  "limitless",
  "final_fix",
] as const;
export type ChipEffect = (typeof CHIP_EFFECTS)[number];
/** What happens to an abandoned session that has a classification (DM 3.9). */
export const ABANDONED_SESSION_POLICIES = ["score_as_classified"] as const;
/** How Strategist's Autopilot breaks a tie between the best-scoring picks. */
export const AUTOPILOT_TIEBREAKS = ["original_then_price"] as const;

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();

const chipSchema = z.strictObject({
  /** Stable (`chip_autopilot`): plays and the ledger refer to it. */
  code: z.string().min(1),
  name: z.string().min(1),
  unlock: z.enum(CHIP_UNLOCKS),
  effect: z.enum(CHIP_EFFECTS),
});

/** Terrible, poor, good, great: a change in $0.1M for each price tier. */
const tierChanges = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
]);

/**
 * The price formula's constants (DM 3.5): an asset's average points over its
 * last `window` events, plus the `unscoredPoints` of its type, against
 * `pointsPerMillion` times its price, give a ratio that falls into a tier. The
 * tier's change depends on the price band: an asset at `bandSplit` or above is
 * expensive. Each change list is in tier order: terrible, poor, good, great,
 * in units of $0.1M.
 */
const priceFormulaSchema = z.strictObject({
  window: positive,
  pointsPerMillion: z.strictObject({
    driver: z.number().positive(),
    constructor: z.number().positive(),
  }),
  /** What the prices expect per event from categories this game doesn't score. */
  unscoredPoints: z.strictObject({
    driver: z.number().nonnegative(),
    constructor: z.number().nonnegative(),
  }),
  bandSplit: positive,
  /** Ratios below `poor` are terrible and from `great` upwards are great. */
  thresholds: z
    .strictObject({
      poor: z.number().positive(),
      good: z.number().positive(),
      great: z.number().positive(),
    })
    .refine((t) => t.poor < t.good && t.good < t.great, {
      message: "thresholds must rise: poor < good < great",
    }),
  changes: z.strictObject({ expensive: tierChanges, cheap: tierChanges }),
});

export const rulesetParamsSchema = z.strictObject({
  squad: z.strictObject({
    drivers: positive,
    constructors: positive,
    boosts: count,
  }),
  /** The starting budget. */
  budget: positive,
  teamsPerUser: positive,
  transfers: z.strictObject({
    freePerEvent: count,
    carryOverMax: count,
    /** Points for each transfer beyond the free ones; zero or less. */
    penalty: z.number().int().max(0),
    /** What a week with unlimited transfers carries forward (DM 3.8). */
    carryOverOutInUnlimitedWeek: count,
  }),
  /** Qualifying and sprint qualifying: Q2 from P16 and Q3 from P10. */
  knockout: z.strictObject({ q2From: positive, q3From: positive }),
  prices: z
    .strictObject({ min: positive, max: positive, formula: priceFormulaSchema })
    .refine((p) => p.min <= p.max, {
      message: "prices.min must not be above prices.max",
    }),
  /** When the next transfer window opens, and how soon to look again. */
  window: z.strictObject({
    openCutoffHours: positive,
    recheckHours: positive,
  }),
  abandonedSessions: z.enum(ABANDONED_SESSION_POLICIES),
  /** What Autopilot does when it has to choose between equal picks. */
  autopilot: z.strictObject({ tiebreak: z.enum(AUTOPILOT_TIEBREAKS) }),
  chips: z
    .array(chipSchema)
    .refine(
      (chips) => new Set(chips.map((c) => c.code)).size === chips.length,
      { message: "chip codes must be unique" },
    ),
});

export type RulesetParams = z.infer<typeof rulesetParamsSchema>;
export type Chip = RulesetParams["chips"][number];

/** Our names for the six chips (not the official ones), in play order. */
export const CHIPS_2026: Chip[] = [
  {
    code: "chip_autopilot",
    name: "Strategist",
    unlock: "from_start",
    effect: "autopilot",
  },
  {
    code: "chip_triple_boost",
    name: "Overdrive",
    unlock: "from_start",
    effect: "triple_boost",
  },
  {
    code: "chip_no_negative",
    name: "Safety Car",
    unlock: "from_start",
    effect: "no_negative",
  },
  {
    code: "chip_wildcard",
    name: "Rebuild",
    unlock: "after_first_event",
    effect: "wildcard",
  },
  {
    code: "chip_limitless",
    name: "Blank Cheque",
    unlock: "after_first_event",
    effect: "limitless",
  },
  {
    code: "chip_final_fix",
    name: "Late Call",
    unlock: "after_first_event",
    effect: "final_fix",
  },
];

/** The 2026 game's rules (DM 3.0, 3.2). */
export const RULESET_2026: RulesetParams = {
  squad: { drivers: 5, constructors: 2, boosts: 1 },
  budget: 1000,
  teamsPerUser: 3,
  transfers: {
    freePerEvent: 2,
    carryOverMax: 1,
    penalty: -10,
    carryOverOutInUnlimitedWeek: 0,
  },
  knockout: { q2From: 16, q3From: 10 },
  // Calibrated on the 2026 season (DM 3.5). The thresholds are the official
  // game's. `unscoredPoints` is what overtakes, Driver of the Day and pit stops
  // earned per asset per event there, which this game doesn't score.
  prices: {
    min: 30,
    max: 340,
    formula: {
      window: 3,
      pointsPerMillion: { driver: 1.0, constructor: 1.0 },
      unscoredPoints: { driver: 6, constructor: 15 },
      bandSplit: 185,
      thresholds: { poor: 0.6, good: 0.9, great: 1.2 },
      changes: { expensive: [-3, -1, 1, 3], cheap: [-6, -2, 2, 6] },
    },
  },
  window: { openCutoffHours: 24, recheckHours: 6 },
  abandonedSessions: "score_as_classified",
  autopilot: { tiebreak: "original_then_price" },
  chips: CHIPS_2026,
};
