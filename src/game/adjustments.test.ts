import { describe, expect, it } from "vitest";
import { seededRandom } from "../../tests/helpers/random";
import {
  effectiveLineup,
  teamAdjustments,
  type AdjustmentLine,
  type TeamEventInput,
  type TeamPick,
} from "./adjustments";
import type { ChipEffect } from "./ruleset";

// Team adjustments (DM 4.3): the Boost, the chips and the transfer penalty, as
// lines on top of the assets' points.

const SESSIONS = [
  { sessionId: "q", kind: "qualifying", order: 1 },
  { sessionId: "s", kind: "sprint", order: 2 },
  { sessionId: "r", kind: "race", order: 3 },
] as const;

function driver(assetId: string, isBoost = false): TeamPick {
  return { assetId, assetType: "driver", isBoost };
}

function constructor(assetId: string): TeamPick {
  return { assetId, assetType: "constructor", isBoost: false };
}

/** One session's points: the total is the sum of the categories. */
function session(
  assets: Record<string, number | Record<string, number>>,
): Map<string, { total: number; byCategory: Record<string, number> }> {
  return new Map(
    Object.entries(assets).map(([assetId, value]) => {
      const byCategory =
        typeof value === "number" ? { race_position: value } : value;
      const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
      return [assetId, { total, byCategory }];
    }),
  );
}

function input(overrides: Partial<TeamEventInput> = {}): TeamEventInput {
  return {
    sessions: [SESSIONS[0], SESSIONS[2]],
    assetPoints: new Map(),
    locked: [driver("d1", true), driver("d2"), driver("d3"), constructor("c1")],
    finalFix: null,
    chip: null,
    transferPenalty: 0,
    prices: new Map(),
    ...overrides,
  };
}

function line(
  lineType: AdjustmentLine["lineType"],
  sessionId: string | null,
  assetId: string | null,
  points: number,
  category: string | null = null,
): AdjustmentLine {
  return { sessionId, assetId, lineType, category, points };
}

describe("teamAdjustments", () => {
  it("Boost adds the Boost driver's points again, per session", () => {
    const lines = teamAdjustments(
      input({
        assetPoints: new Map([
          ["q", session({ d1: 10, d2: 4 })],
          ["r", session({ d1: -3, d2: 8 })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("boost", "q", "d1", 10),
      line("boost", "r", "d1", -3),
    ]);
  });

  it("has no Boost line for a lineup without a Boost pick, and none for zero points", () => {
    const noBoost = input({
      locked: [driver("d1"), driver("d2")],
      assetPoints: new Map([["q", session({ d1: 10 })]]),
    });
    expect(teamAdjustments(noBoost)).toEqual([]);
    const zero = input({
      assetPoints: new Map([["q", session({ d1: 0, d2: 5 })]]),
    });
    expect(teamAdjustments(zero)).toEqual([]);
  });

  it("Overdrive adds twice the target's points, and the Boost still applies to its own driver", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "triple_boost", targetAssetId: "d2" },
        assetPoints: new Map([
          ["q", session({ d1: 10, d2: 7 })],
          ["r", session({ d1: 5, d2: -3 })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("boost", "q", "d1", 10),
      line("triple_boost", "q", "d2", 14),
      line("boost", "r", "d1", 5),
      line("triple_boost", "r", "d2", -6),
    ]);
  });

  it("Overdrive scores only in sessions where the target is in the lineup", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "triple_boost", targetAssetId: "d9" },
        sessions: [SESSIONS[0], SESSIONS[2]],
        finalFix: {
          fromSessionId: "r",
          picks: [driver("d1", true), driver("d9"), constructor("c1")],
        },
        assetPoints: new Map([
          ["q", session({ d1: 1, d9: 50 })],
          ["r", session({ d1: 1, d9: 6 })],
        ]),
      }),
    );
    expect(lines.filter((l) => l.lineType === "triple_boost")).toEqual([
      line("triple_boost", "r", "d9", 12),
    ]);
  });

  it("Strategist moves the Boost to the top scorer as a remove and add pair", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "autopilot", targetAssetId: null },
        assetPoints: new Map([
          ["q", session({ d1: 4, d2: 10, d3: 2, c1: 50 })],
          ["r", session({ d1: 6, d2: 20, d3: 1 })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("boost", "q", "d1", 4),
      line("boost", "r", "d1", 6),
      line("autopilot_remove", null, "d1", -10),
      line("autopilot_add", null, "d2", 30),
    ]);
  });

  it("Strategist adds nothing when the chosen driver leads", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "autopilot", targetAssetId: null },
        assetPoints: new Map([
          ["q", session({ d1: 10, d2: 4 })],
          ["r", session({ d1: 20, d2: 5 })],
        ]),
      }),
    );
    expect(lines.map((l) => l.lineType)).toEqual(["boost", "boost"]);
  });

  it("a Strategist tie keeps the original Boost", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "autopilot", targetAssetId: null },
        // d2 has the higher price, but the original Boost wins the tie.
        prices: new Map([
          ["d1", 100],
          ["d2", 300],
        ]),
        assetPoints: new Map([["q", session({ d1: 20, d2: 20, d3: 3 })]]),
      }),
    );
    expect(lines.map((l) => l.lineType)).toEqual(["boost"]);
  });

  it("a Strategist tie without the original goes to the higher price, then the lower asset id", () => {
    const points = new Map([["q", session({ d1: 5, d2: 20, d3: 20 })]]);
    const chip = { effect: "autopilot", targetAssetId: null } as const;
    const byPrice = teamAdjustments(
      input({
        chip,
        assetPoints: points,
        prices: new Map([
          ["d2", 100],
          ["d3", 120],
        ]),
      }),
    );
    expect(byPrice.filter((l) => l.lineType === "autopilot_add")).toEqual([
      line("autopilot_add", null, "d3", 20),
    ]);
    const byId = teamAdjustments(
      input({
        chip,
        assetPoints: points,
        prices: new Map([
          ["d2", 120],
          ["d3", 120],
        ]),
      }),
    );
    expect(byId.filter((l) => l.lineType === "autopilot_add")).toEqual([
      line("autopilot_add", null, "d2", 20),
    ]);
  });

  it("Strategist is recomputed as sessions are scored", () => {
    const assetPoints = new Map([
      ["q", session({ d1: 5, d2: 10, d3: 4 })],
      ["r", session({ d1: 8, d2: 1, d3: 50 })],
    ]);
    const chip = { effect: "autopilot", targetAssetId: null } as const;
    const afterQualifying = teamAdjustments(
      input({ chip, assetPoints, sessions: [SESSIONS[0]] }),
    );
    expect(afterQualifying).toEqual([
      line("boost", "q", "d1", 5),
      line("autopilot_remove", null, "d1", -5),
      line("autopilot_add", null, "d2", 10),
    ]);
    const afterRace = teamAdjustments(
      input({ chip, assetPoints, sessions: [SESSIONS[0], SESSIONS[2]] }),
    );
    expect(afterRace).toEqual([
      line("boost", "q", "d1", 5),
      line("boost", "r", "d1", 8),
      line("autopilot_remove", null, "d1", -13),
      line("autopilot_add", null, "d3", 54),
    ]);
  });

  it("Safety Car floors each negative category, per asset and session", () => {
    const lines = teamAdjustments(
      input({
        locked: [driver("d1"), driver("d2"), constructor("c1")],
        chip: { effect: "no_negative", targetAssetId: null },
        assetPoints: new Map([
          [
            "r",
            session({
              d2: { race_positions: -5, race_finish: 10 },
              d1: { race_positions: 3, race_finish: 2 },
            }),
          ],
        ]),
        sessions: [SESSIONS[2]],
      }),
    );
    expect(lines).toEqual([
      line("no_negative", "r", "d2", 5, "race_positions"),
    ]);
  });

  it("Safety Car floors a constructor's category subtotal, not each driver's", () => {
    // Both drivers' race positions are one subtotal on the constructor: -5 and
    // +2 is -3, so 3 comes back (not 5).
    const lines = teamAdjustments(
      input({
        locked: [driver("d1"), constructor("c1")],
        chip: { effect: "no_negative", targetAssetId: null },
        sessions: [SESSIONS[2]],
        assetPoints: new Map([
          ["r", session({ c1: { race_positions: -3, race_finish: 4 } })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("no_negative", "r", "c1", 3, "race_positions"),
    ]);
  });

  it("Safety Car doesn't floor the transfer penalty", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "no_negative", targetAssetId: null },
        transferPenalty: -8,
      }),
    );
    expect(lines).toEqual([line("transfer_penalty", null, null, -8)]);
  });

  it("with Safety Car, the Boost doubles the floored score", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "no_negative", targetAssetId: null },
        sessions: [SESSIONS[2]],
        assetPoints: new Map([
          ["r", session({ d1: { race_positions: -5, race_finish: 10 } })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("no_negative", "r", "d1", 5, "race_positions"),
      // The floored score is 10 (positions 0, finish 10), so the Boost adds 10.
      line("boost", "r", "d1", 10),
    ]);
  });

  it("Safety Car lines come by session, then asset, then category, before the Boost", () => {
    const lines = teamAdjustments(
      input({
        chip: { effect: "no_negative", targetAssetId: null },
        assetPoints: new Map([
          [
            "r",
            session({
              d2: { b: -1, a: -2 },
              c1: { z: -4 },
            }),
          ],
          ["q", session({ d3: { x: -1 } })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("no_negative", "q", "d3", 1, "x"),
      line("no_negative", "r", "c1", 4, "z"),
      line("no_negative", "r", "d2", 2, "a"),
      line("no_negative", "r", "d2", 1, "b"),
    ]);
  });

  it("Late Call: qualifying uses the locked lineup and the race the Late Call one", () => {
    const base = input({
      sessions: [SESSIONS[0], SESSIONS[1], SESSIONS[2]],
      finalFix: {
        fromSessionId: "r",
        picks: [driver("d4", true), driver("d5"), constructor("c2")],
      },
    });
    expect(effectiveLineup(base, "q")).toEqual(base.locked);
    expect(effectiveLineup(base, "s")).toEqual(base.locked);
    expect(effectiveLineup(base, "r")).toEqual(base.finalFix!.picks);
    expect(effectiveLineup({ ...base, finalFix: null }, "r")).toEqual(
      base.locked,
    );
    // A Late Call from a session that isn't scored yet hasn't taken effect.
    expect(
      effectiveLineup(
        { ...base, finalFix: { ...base.finalFix!, fromSessionId: "later" } },
        "r",
      ),
    ).toEqual(base.locked);
  });

  it("Late Call: the Boost moves to the incoming driver for the race only", () => {
    const lines = teamAdjustments(
      input({
        finalFix: {
          fromSessionId: "r",
          picks: [driver("d2", true), driver("d3"), constructor("c1")],
        },
        assetPoints: new Map([
          ["q", session({ d1: 10, d2: 3 })],
          ["r", session({ d1: 40, d2: 7 })],
        ]),
      }),
    );
    expect(lines).toEqual([
      line("boost", "q", "d1", 10),
      line("boost", "r", "d2", 7),
    ]);
  });

  it("the transfer penalty is one event-level line", () => {
    const lines = teamAdjustments(
      input({
        transferPenalty: -12,
        chip: { effect: "autopilot", targetAssetId: null },
        assetPoints: new Map([["q", session({ d1: 4, d2: 10 })]]),
      }),
    );
    expect(lines.filter((l) => l.lineType === "transfer_penalty")).toEqual([
      line("transfer_penalty", null, null, -12),
    ]);
    // After the other event-level lines.
    expect(lines.at(-1)).toEqual(line("transfer_penalty", null, null, -12));
    expect(teamAdjustments(input({ transferPenalty: 0 }))).toEqual([]);
  });

  it("Wildcard, Limitless and Late Call add no lines of their own", () => {
    for (const effect of ["wildcard", "limitless", "final_fix"] as const) {
      const lines = teamAdjustments(
        input({
          chip: { effect, targetAssetId: null },
          locked: [driver("d1"), driver("d2")],
          assetPoints: new Map([["q", session({ d1: -4, d2: 10 })]]),
        }),
      );
      expect(lines).toEqual([]);
    }
  });

  it("scores the sessions in order, whatever order they come in", () => {
    const lines = teamAdjustments(
      input({
        sessions: [SESSIONS[2], SESSIONS[0]],
        assetPoints: new Map([
          ["q", session({ d1: 1 })],
          ["r", session({ d1: 2 })],
        ]),
      }),
    );
    expect(lines.map((l) => l.sessionId)).toEqual(["q", "r"]);
  });
});

// A straightforward recount of a team's event, written without the code under
// test: total the picks of each session, then apply the Boost and the chip.
function recount(i: TeamEventInput): number {
  const ordered = [...i.sessions].sort((a, b) => a.order - b.order);
  const fixFrom = i.finalFix
    ? ordered.findIndex((s) => s.sessionId === i.finalFix!.fromSessionId)
    : -1;
  const picksAt = (index: number): TeamPick[] =>
    i.finalFix && fixFrom !== -1 && index >= fixFrom
      ? i.finalFix.picks
      : i.locked;
  const effect: ChipEffect | null = i.chip?.effect ?? null;

  const score = (sessionId: string, assetId: string): number => {
    const p = i.assetPoints.get(sessionId)?.get(assetId);
    if (!p) return 0;
    if (effect !== "no_negative") return p.total;
    return Object.values(p.byCategory).reduce((a, v) => a + Math.max(v, 0), 0);
  };

  let total = 0;
  // Event points of each driver in the sessions they were picked.
  const driverEvent = new Map<string, number>();
  let boostEarned = 0;
  const originalBoost = i.locked.find((p) => p.isBoost)?.assetId ?? null;
  ordered.forEach((s, index) => {
    for (const pick of picksAt(index)) {
      const got = score(s.sessionId, pick.assetId);
      total += got;
      if (pick.assetType === "driver") {
        const raw =
          i.assetPoints.get(s.sessionId)?.get(pick.assetId)?.total ?? 0;
        driverEvent.set(
          pick.assetId,
          (driverEvent.get(pick.assetId) ?? 0) + raw,
        );
      }
      if (pick.isBoost) {
        total += got;
        if (pick.assetId === originalBoost) boostEarned += got;
      }
      if (effect === "triple_boost" && pick.assetId === i.chip!.targetAssetId) {
        total += 2 * got;
      }
    }
  });

  if (effect === "autopilot" && originalBoost !== null) {
    let best: string | null = null;
    for (const [id, pts] of driverEvent) {
      if (best === null) {
        best = id;
        continue;
      }
      const bestPts = driverEvent.get(best)!;
      const better =
        pts !== bestPts
          ? pts > bestPts
          : (id === originalBoost) !== (best === originalBoost)
            ? id === originalBoost
            : (i.prices.get(id) ?? 0) !== (i.prices.get(best) ?? 0)
              ? (i.prices.get(id) ?? 0) > (i.prices.get(best) ?? 0)
              : id < best;
      if (better) best = id;
    }
    if (best !== null && best !== originalBoost) {
      total += driverEvent.get(best)! - boostEarned;
    }
  }
  return total + i.transferPenalty;
}

describe("teamAdjustments properties", () => {
  it("base points plus adjustments equal a straightforward recount", () => {
    const random = seededRandom(4);
    const int = (n: number) => Math.floor(random() * n);
    const one = <T>(items: readonly T[]): T => items[int(items.length)]!;

    for (let run = 0; run < 300; run++) {
      const sessionCount = 1 + int(3);
      const sessions = SESSIONS.slice(3 - sessionCount).map((s) => ({ ...s }));
      // Shuffle the input order.
      sessions.sort(() => random() - 0.5);

      const drivers = ["d1", "d2", "d3", "d4", "d5", "d6"];
      const constructors = ["c1", "c2"];
      const lineupOf = (): TeamPick[] => {
        const chosen = drivers.filter(() => random() < 0.5).slice(0, 5);
        if (chosen.length === 0) chosen.push(one(drivers));
        const boost = one(chosen);
        return [
          ...chosen.map((id) => driver(id, id === boost)),
          constructor(one(constructors)),
        ];
      };

      const effect = one<ChipEffect | null>([
        null,
        "autopilot",
        "triple_boost",
        "no_negative",
        "wildcard",
        "limitless",
        "final_fix",
      ]);
      const locked = lineupOf();
      const assetPoints: TeamEventInput["assetPoints"] = new Map();
      for (const s of sessions) {
        const perAsset = new Map<
          string,
          { total: number; byCategory: Record<string, number> }
        >();
        for (const id of [...drivers, ...constructors]) {
          if (random() < 0.15) continue;
          const byCategory: Record<string, number> = {};
          for (const category of [
            "race_positions",
            "race_position",
            "race_penalty",
          ]) {
            if (random() < 0.5) byCategory[category] = int(21) - 8;
          }
          const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
          perAsset.set(id, { total, byCategory });
        }
        assetPoints.set(s.sessionId, perAsset);
      }

      const sessionIds = sessions.map((s) => s.sessionId);
      const i: TeamEventInput = {
        sessions,
        assetPoints,
        locked,
        finalFix:
          effect === "final_fix"
            ? {
                picks: lineupOf(),
                fromSessionId: random() < 0.1 ? "elsewhere" : one(sessionIds),
              }
            : null,
        chip: effect
          ? {
              effect,
              targetAssetId:
                effect === "triple_boost"
                  ? one(locked.filter((p) => p.assetType === "driver")).assetId
                  : null,
            }
          : null,
        transferPenalty: one([0, 0, -10, -20]),
        // Few distinct prices, so ties on price happen.
        prices: new Map(drivers.map((id) => [id, 100 + int(3) * 10])),
      };

      // Base points: the picks' raw totals, session by session.
      const lines = teamAdjustments(i);
      const base = (() => {
        const ordered = [...sessions].sort((a, b) => a.order - b.order);
        let sum = 0;
        ordered.forEach((s, index) => {
          const fix = i.finalFix;
          const fixFrom = fix
            ? ordered.findIndex((o) => o.sessionId === fix.fromSessionId)
            : -1;
          const picks =
            fix && fixFrom !== -1 && index >= fixFrom ? fix.picks : locked;
          for (const p of picks) {
            sum += assetPoints.get(s.sessionId)?.get(p.assetId)?.total ?? 0;
          }
        });
        return sum;
      })();
      const adjusted = base + lines.reduce((a, l) => a + l.points, 0);
      expect(adjusted, `run ${run}`).toBe(recount(i));
      expect(
        lines.every((l) => l.points !== 0),
        `run ${run}: no zero lines`,
      ).toBe(true);
    }
  });
});
