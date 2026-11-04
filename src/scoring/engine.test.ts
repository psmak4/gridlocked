import { describe, expect, it } from "vitest";
import {
  scoreSession,
  type AssetLine,
  type PoolEntry,
  type ResultFact,
  type SessionInput,
} from "./engine";
import { SCORING_RULES_2026 } from "./rules";

// The scoring engine's golden cases (DM 4.2, HLD §5.6): small sessions built by
// hand against the 2026 rules, with the exact lines asserted.

const KNOCKOUT = { q2From: 16, q3From: 10 };

/** A classified result with nothing else notable; `over` changes what a case is about. */
function row(
  driverId: string,
  constructorId: string,
  over: Partial<ResultFact> = {},
): ResultFact {
  return {
    driverId,
    constructorId,
    position: null,
    classification: "classified",
    grid: null,
    pitLaneStart: false,
    fastestLapRank: null,
    q1Ms: 90_000,
    ...over,
  };
}

const poolDriver = (id: string): PoolEntry => ({
  assetId: id,
  assetType: "driver",
  driverId: id,
  constructorId: null,
});
const poolConstructor = (id: string): PoolEntry => ({
  assetId: id,
  assetType: "constructor",
  driverId: null,
  constructorId: id,
});

function score(
  sessionKind: SessionInput["sessionKind"],
  results: ResultFact[],
  pool: PoolEntry[],
): AssetLine[] {
  return scoreSession({
    sessionKind,
    rules: SCORING_RULES_2026,
    knockout: KNOCKOUT,
    results,
    pool,
  });
}

/** A line as `[asset, rule, subject driver, points]`, to compare whole outputs. */
const brief = (lines: AssetLine[]) =>
  lines.map((l) => [l.assetId, l.ruleCode, l.subjectDriverId, l.points]);

describe("qualifying", () => {
  it("qualifying P1 scores 10, P10 scores 1 and P11 scores nothing", () => {
    const lines = score(
      "qualifying",
      [
        row("a", "t1", { position: 1 }),
        row("b", "t2", { position: 10 }),
        row("c", "t3", { position: 11 }),
      ],
      [poolDriver("a"), poolDriver("b"), poolDriver("c")],
    );
    expect(brief(lines)).toEqual([
      ["a", "qualifying.position", null, 10],
      ["b", "qualifying.position", null, 1],
    ]);
    expect(lines[0]).toEqual({
      assetId: "a",
      ruleCode: "qualifying.position",
      category: "qualifying_position",
      subjectDriverId: null,
      points: 10,
      detail: { position: 1 },
    });
  });

  it("no time set in qualifying scores -5", () => {
    const lines = score(
      "qualifying",
      [row("a", "t1", { position: 20, q1Ms: null })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([
      ["a", "qualifying.not_classified", null, -5],
    ]);
    expect(lines[0]?.category).toBe("qualifying_penalty");
    expect(lines[0]?.detail).toEqual({ reason: "no_time" });
  });

  it("a qualifying DSQ scores -5 and no position points", () => {
    const lines = score(
      "qualifying",
      [row("a", "t1", { position: 3, classification: "disqualified" })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([
      ["a", "qualifying.not_classified", null, -5],
    ]);
    expect(lines[0]?.detail).toEqual({ classification: "disqualified" });
  });

  it("an inactive pool driver with no qualifying row scores -5", () => {
    const lines = score(
      "qualifying",
      [row("a", "t1", { position: 1 })],
      [poolDriver("a"), poolDriver("idle")],
    );
    expect(brief(lines)).toEqual([
      ["a", "qualifying.position", null, 10],
      ["idle", "qualifying.not_classified", null, -5],
    ]);
    expect(lines[1]?.detail).toEqual({ reason: "absent" });
  });

  it("the knockout tiers", () => {
    const tiers = [
      { positions: [17, 18], points: -1, tier: "noneQ2" },
      { positions: [12, 17], points: 1, tier: "oneQ2" },
      { positions: [12, 14], points: 3, tier: "bothQ2" },
      { positions: [8, 14], points: 5, tier: "oneQ3" },
      { positions: [8, 19], points: 5, tier: "oneQ3" },
      { positions: [3, 9], points: 10, tier: "bothQ3" },
    ];
    const got = tiers.map(({ positions, tier }) => {
      const lines = score(
        "qualifying",
        [
          row("a", "team", { position: positions[0] ?? null }),
          row("b", "team", { position: positions[1] ?? null }),
        ],
        [poolConstructor("team")],
      ).filter((l) => l.ruleCode === "qualifying.knockout");
      return { tier, lines: brief(lines), detail: lines[0]?.detail };
    });
    expect(got).toEqual(
      tiers.map(({ tier, points }) => ({
        tier,
        lines: [["team", "qualifying.knockout", null, points]],
        detail: { tier },
      })),
    );
  });

  it("a Q3 driver with no Q3 time still counts as reaching Q3", () => {
    // The engine never reads Q3 times (ResultFact has none), so position
    // alone decides: a Q3 driver who set no time is still in Q3.
    const lines = score(
      "qualifying",
      [row("a", "team", { position: 9 }), row("b", "team", { position: 4 })],
      [poolConstructor("team")],
    ).filter((l) => l.ruleCode === "qualifying.knockout");
    expect(brief(lines)).toEqual([["team", "qualifying.knockout", null, 10]]);
  });

  it("a disqualified qualifier with a position doesn't reach Q3", () => {
    const lines = score(
      "qualifying",
      [
        row("a", "team", { position: 3, classification: "disqualified" }),
        row("b", "team", { position: 5 }),
      ],
      [poolConstructor("team")],
    ).filter((l) => l.ruleCode === "qualifying.knockout");
    expect(brief(lines)).toEqual([["team", "qualifying.knockout", null, 5]]);
    expect(lines[0]?.detail).toEqual({ tier: "oneQ3" });
  });

  it("a constructor with one qualifying driver row scores on that driver", () => {
    const lines = score(
      "qualifying",
      [row("a", "team", { position: 5 })],
      [poolConstructor("team")],
    ).filter((l) => l.ruleCode === "qualifying.knockout");
    expect(brief(lines)).toEqual([["team", "qualifying.knockout", null, 5]]);
  });

  it("a constructor with no qualifying rows has no knockout line", () => {
    const lines = score(
      "qualifying",
      [row("a", "other", { position: 5 })],
      [poolConstructor("team")],
    );
    expect(lines).toEqual([]);
  });

  it("a qualifying DSQ costs the constructor -5 twice", () => {
    const lines = score(
      "qualifying",
      [
        row("a", "team", { position: null, classification: "disqualified" }),
        row("b", "team", { position: 5 }),
      ],
      [poolConstructor("team")],
    );
    expect(brief(lines)).toEqual([
      ["team", "qualifying.position", "b", 6],
      ["team", "qualifying.not_classified", "a", -5],
      ["team", "qualifying.knockout", null, 5],
      ["team", "qualifying.disqualified", "a", -5],
    ]);
    expect(lines[1]?.category).toBe("qualifying_penalty");
    expect(lines[3]?.category).toBe("qualifying_penalty");
  });
});

describe("sprint", () => {
  it("P10 to P3 in the sprint scores +7 and 6", () => {
    const lines = score(
      "sprint",
      [row("a", "t1", { grid: 10, position: 3 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([
      ["a", "sprint.positions", null, 7],
      ["a", "sprint.position", null, 6],
    ]);
    expect(lines[0]?.detail).toEqual({ grid: 10, position: 3 });
  });

  it("sprint positions lost are capped at -10", () => {
    const lines = score(
      "sprint",
      [row("a", "t1", { grid: 5, position: 20 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "sprint.positions", null, -10]]);
  });

  it("the sprint fastest lap scores +5", () => {
    const lines = score(
      "sprint",
      [row("a", "t1", { grid: 12, position: 12, fastestLapRank: 1 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "sprint.fastest_lap", null, 5]]);
  });

  it("a sprint NC scores -10, with no positions lost and no fastest lap", () => {
    const lines = score(
      "sprint",
      [
        row("a", "t1", {
          classification: "not_classified",
          grid: 5,
          position: 18,
          fastestLapRank: 1,
        }),
      ],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "sprint.not_classified", null, -10]]);
  });

  it("a sprint DSQ costs the constructor -10 twice", () => {
    const lines = score(
      "sprint",
      [
        row("a", "team", { classification: "disqualified", grid: 4 }),
        row("b", "team", { grid: 9, position: 9 }),
      ],
      [poolConstructor("team")],
    );
    expect(brief(lines)).toEqual([
      ["team", "sprint.not_classified", "a", -10],
      ["team", "sprint.disqualified", "a", -10],
    ]);
  });
});

describe("race", () => {
  it("P1 from P1 scores 25", () => {
    const lines = score(
      "race",
      [row("a", "t1", { grid: 1, position: 1 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "race.position", null, 25]]);
  });

  it("P2 from P10 scores +8 and 18", () => {
    const lines = score(
      "race",
      [row("a", "t1", { grid: 10, position: 2 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([
      ["a", "race.positions", null, 8],
      ["a", "race.position", null, 18],
    ]);
  });

  it("race positions lost aren't capped", () => {
    const lines = score(
      "race",
      [row("a", "t1", { grid: 3, position: 19 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "race.positions", null, -16]]);
  });

  it("the race fastest lap scores +10", () => {
    const lines = score(
      "race",
      [row("a", "t1", { grid: 15, position: 15, fastestLapRank: 1 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "race.fastest_lap", null, 10]]);
  });

  it("a race NC scores -20 only", () => {
    const lines = score(
      "race",
      [
        row("a", "t1", {
          classification: "not_classified",
          grid: 5,
          position: 18,
          fastestLapRank: 1,
        }),
      ],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "race.not_classified", null, -20]]);
  });

  it("a DNS and a withdrawn (W) driver score -20", () => {
    // The provider adapter turns a withdrawn driver into `did_not_start` too.
    const lines = score(
      "race",
      [
        row("dns", "t1", { classification: "did_not_start", grid: 8 }),
        row("w", "t2", { classification: "did_not_start" }),
      ],
      [poolDriver("dns"), poolDriver("w")],
    );
    expect(brief(lines)).toEqual([
      ["dns", "race.not_classified", null, -20],
      ["w", "race.not_classified", null, -20],
    ]);
  });

  it("a pit-lane start counts as last on the grid", () => {
    // Synthetic: 2026 had no pit-lane start. 22 rows, so the grid is P22.
    const filler = Array.from({ length: 21 }, (_, i) =>
      row(`f${i}`, `ft${i}`, { grid: i + 1, position: i + 1 }),
    );
    const lines = score(
      "race",
      [
        ...filler,
        row("pit", "pt", { grid: 3, pitLaneStart: true, position: 15 }),
      ],
      [poolDriver("pit")],
    );
    expect(brief(lines)).toEqual([["pit", "race.positions", null, 7]]);
    expect(lines[0]?.detail).toEqual({ grid: 22, position: 15 });
  });

  it("DSQ, NC and W are told apart", () => {
    const lines = score(
      "race",
      [
        row("dsq", "t1", { classification: "disqualified", grid: 4 }),
        row("nc", "t2", { classification: "not_classified", grid: 6 }),
        row("w", "t3", { classification: "did_not_start" }),
      ],
      [poolConstructor("t1"), poolConstructor("t2"), poolConstructor("t3")],
    );
    expect(brief(lines)).toEqual([
      ["t1", "race.not_classified", "dsq", -20],
      ["t1", "race.disqualified", "dsq", -20],
      ["t2", "race.not_classified", "nc", -20],
      ["t3", "race.not_classified", "w", -20],
    ]);
  });
});

describe("roster changes", () => {
  it("a substitute who isn't in the pool scores inside his constructor's aggregate", () => {
    const lines = score(
      "race",
      [
        row("ver", "rbr", { grid: 1, position: 1 }),
        row("sub", "rbr", { grid: 3, position: 3 }),
      ],
      [poolDriver("ver"), poolConstructor("rbr")],
    );
    expect(brief(lines)).toEqual([
      ["rbr", "race.position", "sub", 15],
      ["rbr", "race.position", "ver", 25],
      ["ver", "race.position", null, 25],
    ]);
  });

  it("a driver scores for the car he drove", () => {
    const lines = score(
      "race",
      [
        row("law", "rbr", { grid: 12, position: 2 }),
        row("lin", "rb", { grid: 9, position: 12 }),
      ],
      [poolDriver("law"), poolConstructor("rbr"), poolConstructor("rb")],
    );
    expect(brief(lines)).toEqual([
      ["law", "race.positions", null, 10],
      ["law", "race.position", null, 18],
      ["rb", "race.positions", "lin", -3],
      ["rbr", "race.positions", "law", 10],
      ["rbr", "race.position", "law", 18],
    ]);
  });

  it("an absent pool driver adds nothing to any constructor", () => {
    const lines = score(
      "race",
      [row("ver", "rbr", { grid: 1, position: 1 })],
      [poolDriver("gone"), poolConstructor("rbr")],
    );
    expect(brief(lines)).toEqual([
      ["gone", "race.not_classified", null, -20],
      ["rbr", "race.position", "ver", 25],
    ]);
  });
});

describe("the lines returned", () => {
  it("zero lines aren't returned", () => {
    const results = [
      row("a", "t1", { grid: 12, position: 12 }),
      row("b", "t2", { grid: 14, position: 14, fastestLapRank: 2 }),
    ];
    const pool = [
      poolDriver("a"),
      poolConstructor("t1"),
      poolConstructor("t2"),
    ];
    expect(score("race", results, pool)).toEqual([]);
  });

  it("sorts by asset, then the rule's sort order, then the subject driver", () => {
    const lines = score(
      "race",
      [
        row("y", "team", { grid: 2, position: 2 }),
        row("x", "team", { grid: 1, position: 1 }),
      ],
      [poolConstructor("team"), poolDriver("x")],
    );
    expect(brief(lines)).toEqual([
      ["team", "race.position", "x", 25],
      ["team", "race.position", "y", 18],
      ["x", "race.position", null, 25],
    ]);
  });

  it("ignores rules for another session", () => {
    const lines = score(
      "qualifying",
      [row("a", "t1", { grid: 1, position: 1, fastestLapRank: 1 })],
      [poolDriver("a")],
    );
    expect(brief(lines)).toEqual([["a", "qualifying.position", null, 10]]);
  });
});

describe("bad input is refused", () => {
  it("a driver asset without a driver id is refused", () => {
    expect(() =>
      score(
        "race",
        [],
        [
          {
            assetId: "ghost",
            assetType: "driver",
            driverId: null,
            constructorId: null,
          },
        ],
      ),
    ).toThrow(/driver asset "ghost"/);
  });

  it("a constructor asset without a constructor id is refused", () => {
    expect(() =>
      score(
        "race",
        [],
        [
          {
            assetId: "ghost",
            assetType: "constructor",
            driverId: null,
            constructorId: null,
          },
        ],
      ),
    ).toThrow(/constructor asset "ghost"/);
  });

  it("a driver twice in the results is refused", () => {
    expect(() =>
      score(
        "race",
        [
          row("a", "t1", { grid: 1, position: 1 }),
          row("a", "t1", { grid: 1, position: 2 }),
        ],
        [poolDriver("a")],
      ),
    ).toThrow(/driver "a" .* twice/);
  });

  it("an asset twice in the pool is refused", () => {
    expect(() =>
      score(
        "race",
        [row("a", "t1", { grid: 2, position: 1 })],
        [poolDriver("a"), poolDriver("a")],
      ),
    ).toThrow(/asset "a" .* twice/);
  });
});
