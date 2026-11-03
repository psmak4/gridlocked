import { describe, expect, it } from "vitest";
import { CHIPS_2026, RULESET_2026, rulesetParamsSchema } from "./ruleset";

describe("the ruleset parameters (DM 3.2)", () => {
  it("RULESET_2026 parses", () => {
    expect(rulesetParamsSchema.parse(RULESET_2026)).toEqual(RULESET_2026);
    expect(CHIPS_2026.map((c) => c.code)).toEqual([
      "chip_autopilot",
      "chip_triple_boost",
      "chip_no_negative",
      "chip_wildcard",
      "chip_limitless",
      "chip_final_fix",
    ]);
  });

  it("an unknown key is refused", () => {
    const top = { ...structuredClone(RULESET_2026), extra: 1 };
    expect(rulesetParamsSchema.safeParse(top).success).toBe(false);

    const nested = structuredClone(RULESET_2026);
    (nested.transfers as Record<string, unknown>).extra = 1;
    expect(rulesetParamsSchema.safeParse(nested).success).toBe(false);

    const chip = structuredClone(RULESET_2026);
    (chip.chips[0] as Record<string, unknown>).extra = 1;
    expect(rulesetParamsSchema.safeParse(chip).success).toBe(false);
  });

  it("a chip code that isn't unique is refused", () => {
    const params = structuredClone(RULESET_2026);
    params.chips[1]!.code = params.chips[0]!.code;
    expect(rulesetParamsSchema.safeParse(params).success).toBe(false);
  });

  it("prices.min above prices.max is refused", () => {
    const params = structuredClone(RULESET_2026);
    params.prices = { min: 341, max: 340 };
    expect(rulesetParamsSchema.safeParse(params).success).toBe(false);
  });
});
