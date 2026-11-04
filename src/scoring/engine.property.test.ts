import { describe, expect, it } from "vitest";
import { seededRandom } from "../../tests/helpers/random";
import {
  scoreSession,
  type AssetLine,
  type PoolEntry,
  type ResultFact,
  type SessionInput,
} from "./engine";
import { SCORING_RULES_2026 } from "./rules";

// Properties of the scoring engine over random sessions (DM 4.2): the
// constructor's totals, order independence, and who gets lines.

const RUNS = 500;
type Random = () => number;

const CLASSIFICATIONS: ResultFact["classification"][] = [
  "not_classified",
  "disqualified",
  "did_not_start",
  "did_not_qualify",
  "excluded",
];

function shuffle<T>(items: T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 18 to 24 drivers, some classified and some not, some pool assets, some absent. */
function randomSession(random: Random): SessionInput {
  const kinds = ["qualifying", "sprint", "race"] as const;
  const sessionKind = kinds[Math.floor(random() * kinds.length)]!;
  const count = 18 + Math.floor(random() * 7);
  const teams = Math.ceil(count / 2);

  const drivers = Array.from({ length: count }, (_, i) => `d${i}`);
  const classifications = drivers.map((): ResultFact["classification"] =>
    random() < 0.78
      ? "classified"
      : CLASSIFICATIONS[Math.floor(random() * CLASSIFICATIONS.length)]!,
  );
  const finishers = shuffle(
    drivers.map((_, i) => i).filter((i) => classifications[i] === "classified"),
    random,
  );
  const positionOf = new Map(finishers.map((driver, i) => [driver, i + 1]));
  const grids = shuffle(
    drivers.map((_, i) => i + 1),
    random,
  );

  const results: ResultFact[] = drivers.map((driverId, i) => ({
    driverId,
    // Two to a team, with the odd substitute driving for another team.
    constructorId: `c${random() < 0.1 ? Math.floor(random() * teams) : Math.floor(i / 2)}`,
    // A few unclassified rows keep a position, which must not score, nor
    // count towards a constructor's knockout stage.
    position:
      positionOf.get(i) ??
      (random() < 0.3 ? 1 + Math.floor(random() * count) : null),
    classification: classifications[i]!,
    grid: random() < 0.9 ? grids[i]! : null,
    pitLaneStart: random() < 0.05,
    fastestLapRank: random() < 0.2 ? 1 + Math.floor(random() * 3) : null,
    q1Ms: random() < 0.9 ? 80_000 + Math.floor(random() * 10_000) : null,
  }));

  const pool: PoolEntry[] = [];
  for (const { driverId } of results) {
    if (random() < 0.5) {
      pool.push({
        assetId: driverId,
        assetType: "driver",
        driverId,
        constructorId: null,
      });
    }
  }
  for (let t = 0; t < teams; t++) {
    if (random() < 0.5) {
      pool.push({
        assetId: `c${t}`,
        assetType: "constructor",
        driverId: null,
        constructorId: `c${t}`,
      });
    }
  }
  // Pool drivers with no result row at all.
  for (let a = Math.floor(random() * 4); a > 0; a--) {
    pool.push({
      assetId: `absent${a}`,
      assetType: "driver",
      driverId: `absent${a}`,
      constructorId: null,
    });
  }

  return {
    sessionKind,
    rules: SCORING_RULES_2026,
    knockout: { q2From: 16, q3From: 10 },
    results,
    pool,
  };
}

/** The codes of the constructor's own rules; the other lines are copied from drivers. */
const constructorCodes = new Set(
  SCORING_RULES_2026.filter(
    (r) => r.target === "constructor" && r.kind !== "aggregate_drivers",
  ).map((r) => r.code),
);

const total = (lines: AssetLine[]) =>
  lines.reduce((sum, l) => sum + l.points, 0);

describe("scoreSession over random sessions", () => {
  it("a constructor's points equal its drivers' driver points plus its own constructor lines", () => {
    const random = seededRandom(2026);
    for (let run = 0; run < RUNS; run++) {
      const session = randomSession(random);
      // Every driver and constructor in the session is in the pool this time.
      const pool: PoolEntry[] = [
        ...new Set(session.results.map((r) => r.driverId)),
        ...new Set(session.results.map((r) => r.constructorId)),
      ].map((id) =>
        id.startsWith("d")
          ? {
              assetId: id,
              assetType: "driver",
              driverId: id,
              constructorId: null,
            }
          : {
              assetId: id,
              assetType: "constructor",
              driverId: null,
              constructorId: id,
            },
      );
      const lines = scoreSession({ ...session, pool });
      const driverTotal = (driverId: string) =>
        total(lines.filter((l) => l.assetId === driverId));

      for (const constructorId of new Set(
        session.results.map((r) => r.constructorId),
      )) {
        const mine = lines.filter((l) => l.assetId === constructorId);
        const drivers = session.results.filter(
          (r) => r.constructorId === constructorId,
        );
        const expected =
          drivers.reduce((sum, r) => sum + driverTotal(r.driverId), 0) +
          total(mine.filter((l) => constructorCodes.has(l.ruleCode)));
        expect(total(mine), `run ${run}, ${constructorId}`).toBe(expected);
      }
    }
  });

  it("shuffling the results gives the same lines", () => {
    const random = seededRandom(2026);
    for (let run = 0; run < RUNS; run++) {
      const session = randomSession(random);
      const shuffled = {
        ...session,
        results: shuffle(session.results, random),
        pool: shuffle(session.pool, random),
      };
      expect(scoreSession(shuffled), `run ${run}`).toEqual(
        scoreSession(session),
      );
    }
  });

  it("only pool assets have lines", () => {
    const random = seededRandom(2026);
    for (let run = 0; run < RUNS; run++) {
      const session = randomSession(random);
      const inPool = new Set(session.pool.map((p) => p.assetId));
      for (const line of scoreSession(session)) {
        expect(inPool.has(line.assetId), `run ${run}, ${line.assetId}`).toBe(
          true,
        );
      }
    }
  });

  it("every absent pool driver has exactly the absent penalty", () => {
    const random = seededRandom(2026);
    for (let run = 0; run < RUNS; run++) {
      const session = randomSession(random);
      const lines = scoreSession(session);
      const present = new Set(session.results.map((r) => r.driverId));
      const penalties = SCORING_RULES_2026.flatMap((rule) =>
        rule.sessionKind === session.sessionKind &&
        rule.kind === "classification_penalty" &&
        rule.params.absent &&
        rule.params.points !== 0
          ? [[rule.code, rule.params.points]]
          : [],
      );
      for (const entry of session.pool) {
        if (entry.assetType !== "driver" || present.has(entry.driverId!)) {
          continue;
        }
        const mine = lines
          .filter((l) => l.assetId === entry.assetId)
          .map((l) => [l.ruleCode, l.points]);
        expect(mine, `run ${run}, ${entry.assetId}`).toEqual(penalties);
      }
    }
  });
});
