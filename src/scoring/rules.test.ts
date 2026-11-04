import { describe, expect, it } from "vitest";
import { rulesetParamsSchema, RULESET_2026 } from "@/game/ruleset";
import { scoringRuleSchema, SCORING_RULES_2026 } from "./rules";

// The 2026 scoring rules as data (DM 3.2, HLD §5.6): the shape of each kind's
// params, and the 17 rows of the 2026 game.

describe("the 2026 scoring rules", () => {
  it("SCORING_RULES_2026 parses", () => {
    expect(SCORING_RULES_2026.map((r) => r.code)).toEqual([
      "qualifying.position",
      "qualifying.not_classified",
      "qualifying.drivers",
      "qualifying.knockout",
      "qualifying.disqualified",
      "sprint.positions",
      "sprint.fastest_lap",
      "sprint.position",
      "sprint.not_classified",
      "sprint.drivers",
      "sprint.disqualified",
      "race.positions",
      "race.fastest_lap",
      "race.position",
      "race.not_classified",
      "race.drivers",
      "race.disqualified",
    ]);
    for (const rule of SCORING_RULES_2026) {
      expect(scoringRuleSchema.parse(rule)).toEqual(rule);
    }
  });

  it("holds the official values", () => {
    const byCode = new Map(SCORING_RULES_2026.map((r) => [r.code, r]));
    const rule = (code: string) => byCode.get(code)!;
    expect(rule("race.position").params).toEqual({
      points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
    });
    expect(rule("sprint.position").params).toEqual({
      points: [8, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(rule("qualifying.position").params).toEqual({
      points: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(rule("sprint.positions").params).toEqual({
      perPosition: 1,
      lostCap: -10,
    });
    expect(rule("race.positions").params).toEqual({
      perPosition: 1,
      lostCap: null,
    });
    expect(rule("qualifying.not_classified").params).toEqual({
      points: -5,
      classifications: [
        "not_classified",
        "did_not_start",
        "excluded",
        "did_not_qualify",
        "disqualified",
      ],
      noTime: true,
      absent: true,
    });
    expect(rule("race.not_classified").params).toMatchObject({
      points: -20,
      noTime: false,
      absent: true,
    });
    expect(rule("sprint.disqualified").params).toEqual({
      points: -10,
      classifications: ["disqualified"],
    });
    expect(rule("qualifying.knockout").params).toEqual({
      noneQ2: -1,
      oneQ2: 1,
      bothQ2: 3,
      oneQ3: 5,
      bothQ3: 10,
    });
    expect(rule("race.fastest_lap").params).toEqual({
      points: 10,
      flag: "fastest_lap",
    });
    expect(rule("sprint.fastest_lap").params).toEqual({
      points: 5,
      flag: "fastest_lap",
    });
  });

  it("has no position table longer than 10", () => {
    for (const rule of SCORING_RULES_2026) {
      if (rule.kind !== "position_table") continue;
      expect(rule.params.points.length).toBeLessThanOrEqual(10);
    }
  });

  it("an unknown param key is refused", () => {
    const rule = SCORING_RULES_2026.find((r) => r.code === "race.position")!;
    const bad = { ...rule, params: { ...rule.params, extra: 1 } };
    expect(scoringRuleSchema.safeParse(bad).success).toBe(false);
  });

  it("a constructor-only kind on a driver rule is refused", () => {
    for (const code of [
      "qualifying.knockout",
      "race.disqualified",
      "race.drivers",
    ]) {
      const rule = SCORING_RULES_2026.find((r) => r.code === code)!;
      expect(rule.target).toBe("constructor");
      expect(scoringRuleSchema.safeParse(rule).success).toBe(true);
      expect(
        scoringRuleSchema.safeParse({ ...rule, target: "driver" }).success,
      ).toBe(false);
    }
  });

  it("a rule whose params belong to another kind is refused", () => {
    const rule = SCORING_RULES_2026.find((r) => r.code === "race.position")!;
    expect(
      scoringRuleSchema.safeParse({ ...rule, kind: "flag_bonus" }).success,
    ).toBe(false);
  });

  it("codes are unique within a ruleset", () => {
    const codes = SCORING_RULES_2026.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("sort orders increase within each session kind", () => {
    const kinds = new Set(SCORING_RULES_2026.map((r) => r.sessionKind));
    for (const kind of kinds) {
      const orders = SCORING_RULES_2026.filter(
        (r) => r.sessionKind === kind,
      ).map((r) => r.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    }
  });
});

describe("the ruleset's price formula and autopilot params", () => {
  it("RULESET_2026 with the formula params parses", () => {
    const parsed = rulesetParamsSchema.parse(RULESET_2026);
    expect(parsed.autopilot).toEqual({ tiebreak: "original_then_price" });
    expect(parsed.prices.formula).toEqual({
      window: 3,
      pointsPerMillion: { driver: 1, constructor: 1 },
      bandSplit: 185,
      thresholds: { poor: 0.6, good: 1.0, great: 1.5 },
      changes: { expensive: [-3, -1, 1, 3], cheap: [-6, -2, 2, 6] },
    });
  });

  it("thresholds out of order are refused", () => {
    const withThresholds = (thresholds: object) => ({
      ...RULESET_2026,
      prices: {
        ...RULESET_2026.prices,
        formula: { ...RULESET_2026.prices.formula, thresholds },
      },
    });
    expect(
      rulesetParamsSchema.safeParse(
        withThresholds({ poor: 1.0, good: 0.6, great: 1.5 }),
      ).success,
    ).toBe(false);
    expect(
      rulesetParamsSchema.safeParse(
        withThresholds({ poor: 0.6, good: 1.0, great: 1.0 }),
      ).success,
    ).toBe(false);
  });

  it("an unknown formula key is refused", () => {
    const bad = {
      ...RULESET_2026,
      prices: {
        ...RULESET_2026.prices,
        formula: { ...RULESET_2026.prices.formula, extra: 1 },
      },
    };
    expect(rulesetParamsSchema.safeParse(bad).success).toBe(false);
  });
});
