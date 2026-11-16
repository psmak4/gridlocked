import { describe, expect, it } from "vitest";
import { SCORING_RULES_2026 } from "@/scoring/rules";
import { lineWords, rowReason, sheetWords } from "./line-words";

/** A detail each rule's lines can carry, as the engine writes it. */
const CASES: Record<string, Array<[detail: unknown, short: string]>> = {
  "qualifying.position": [[{ position: 3 }, "P3"]],
  "qualifying.not_classified": [
    [{ reason: "no_time" }, "No time set"],
    [{ reason: "absent" }, "Didn't take part"],
    [{ classification: "did_not_qualify" }, "Did not qualify"],
  ],
  "qualifying.drivers": [[{}, "Both drivers"]],
  "qualifying.knockout": [
    [{ tier: "bothQ3" }, "both in Q3"],
    [{ tier: "oneQ3" }, "one in Q3"],
    [{ tier: "bothQ2" }, "both in Q2"],
    [{ tier: "oneQ2" }, "one in Q2"],
    [{ tier: "noneQ2" }, "neither in Q2"],
  ],
  "qualifying.disqualified": [
    [{ classification: "disqualified" }, "a driver disqualified"],
  ],
  "sprint.positions": [
    [{ grid: 9, position: 4 }, "gained 5 places"],
    [{ grid: 3, position: 4 }, "lost 1 place"],
  ],
  "sprint.fastest_lap": [[{ flag: "fastest_lap" }, "fastest lap"]],
  "sprint.position": [[{ position: 1 }, "P1"]],
  "sprint.not_classified": [
    [{ classification: "did_not_start" }, "Did not start"],
  ],
  "sprint.drivers": [[{}, "Both drivers"]],
  "sprint.disqualified": [
    [{ classification: "disqualified" }, "a driver disqualified"],
  ],
  "race.positions": [
    [{ grid: 6, position: 3 }, "gained 3 places"],
    [{ grid: 2, position: 7 }, "lost 5 places"],
  ],
  "race.fastest_lap": [[{ flag: "fastest_lap" }, "fastest lap"]],
  "race.position": [[{ position: 3 }, "P3"]],
  "race.not_classified": [
    [{ classification: "not_classified" }, "Not classified"],
    [{ classification: "excluded" }, "Excluded"],
  ],
  "race.drivers": [[{}, "Both drivers"]],
  "race.disqualified": [
    [{ classification: "disqualified" }, "a driver disqualified"],
  ],
};

describe("lineWords", () => {
  for (const rule of SCORING_RULES_2026) {
    it(`${rule.code} has words`, () => {
      const cases = CASES[rule.code];
      expect(cases, `a case for ${rule.code}`).toBeDefined();
      for (const [detail, short] of cases!) {
        expect(lineWords(rule.code, detail)).toBe(short);
        const sheet = sheetWords(rule.code, detail);
        expect(sheet.label.length).toBeGreaterThan(0);
        expect(sheet.why.length).toBeGreaterThan(0);
      }
    });
  }

  it("an unknown code throws", () => {
    expect(() => lineWords("race.overtakes", {})).toThrow(/race\.overtakes/);
    expect(() => sheetWords("race.overtakes", {})).toThrow();
  });

  it("the sheet spells a line out", () => {
    expect(sheetWords("race.position", { position: 3 })).toEqual({
      label: "Finished P3",
      why: "Race finishing position",
    });
    expect(sheetWords("race.positions", { grid: 6, position: 3 })).toEqual({
      label: "Gained 3 places",
      why: "Started P6, finished P3",
    });
    expect(sheetWords("qualifying.position", { position: 4 })).toEqual({
      label: "Qualified P4",
      why: "Qualifying finishing position",
    });
  });
});

describe("rowReason", () => {
  it("puts the position first, then the places", () => {
    expect(
      rowReason([
        { ruleCode: "race.positions", detail: { grid: 6, position: 3 } },
        { ruleCode: "race.position", detail: { position: 3 } },
      ]),
    ).toBe("P3 · gained 3 places");
  });

  it("says a word once, and capitalizes the first", () => {
    expect(
      rowReason([
        { ruleCode: "qualifying.knockout", detail: { tier: "bothQ3" } },
        { ruleCode: "qualifying.position", detail: { position: 2 } },
        { ruleCode: "qualifying.position", detail: { position: 2 } },
      ]),
    ).toBe("P2 · both in Q3");
    expect(
      rowReason([{ ruleCode: "race.fastest_lap", detail: { flag: "x" } }]),
    ).toBe("Fastest lap");
  });

  it("no lines: No points", () => {
    expect(rowReason([])).toBe("No points");
  });
});
