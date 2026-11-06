import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { z } from "zod";
import { createTestDb } from "../../../tests/helpers/test-db";
import { readFixture } from "../../../tests/helpers/fixtures";
import { idFor } from "../../../tests/helpers/ingest-2026";
import { RECORDED_THROUGH_ROUND } from "../../../tests/helpers/recorded-2026";
import {
  createTestLeagues,
  lateStewardsPenalty,
  replayScores2026,
} from "../../../tests/helpers/replay-2026";
import {
  assetPrices,
  assetScoreLines,
  events,
  gameEvents,
  games,
  leagues,
  leagueStandings,
  poolAssets,
  priceUpdateRuns,
  results,
  scoringRuns,
  sessions,
  teamBaseLines,
  teamEventTotals,
  teams,
} from "@/db/schema";
import { checkScoringLedger } from "@/game/scoring-invariants";

// The M4 exit (Task 10): the real 2026 season through the whole pipeline, poll
// to standings, on the simulated clock, for the teams of
// tests/fixtures/scores-2026-script.json. One replay is shared by every
// assertion but the late penalty's, which has a shorter one of its own.
//
// tests/fixtures/scores-2026-expected.json is our own numbers, written by this
// file: to regenerate it, read why the numbers moved, then run
//   UPDATE_SCORES_EXPECTED=1 pnpm vitest run --project db src/providers/replay/season-scoring.test.ts

/** The replay runs in `beforeAll`, over the hook limit of the db project. */
const SEASON_TIMEOUT_MS = 600_000;
const THROUGH = RECORDED_THROUGH_ROUND;
const CANCELLED_ROUND = 4;
const SPRINT_ROUNDS = [2, 5, 9, 12, 17];
/** After the last team is created. */
const LEAGUES_AT = "2026-05-23T13:00:00Z";
const LEAGUES: Record<string, [number, number?]> = {
  "Whole season": [1],
  "Rounds 5 to 10": [4, 9],
  "From round 6": [5],
};

/**
 * The official game's shares of terrible, poor, good and great moves, in %,
 * rounds 1 to 19 (DM 3.5). The calibration's target, summary numbers only.
 */
const OFFICIAL_TIER_SHARES = {
  cheap: [42, 11, 11, 36],
  expensive: [16, 14, 16, 55],
};

/** What this file reads of `price_update_runs.inputs`. */
interface PriceInputs {
  assets: {
    assetId: string;
    price: number;
    newPrice: number;
    tier: "terrible" | "poor" | "good" | "great" | null;
    kept?: "admin";
    absent?: true;
  }[];
}

const EXPECTED_PATH = fileURLToPath(
  new URL("../../../tests/fixtures/scores-2026-expected.json", import.meta.url),
);
const expectedSchema = z.object({
  note: z.string(),
  throughRound: z.number(),
  teams: z.record(z.string(), z.record(z.string(), z.number())),
});

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const gameOf = async (t: TestDb) => {
  const [game] = await t.db.select({ id: games.id }).from(games);
  return game!.id;
};

/** Each team's points per round, by its name. */
async function pointsByRound(t: TestDb) {
  const rows = await t.db
    .select({
      name: teams.name,
      round: events.round,
      points: teamEventTotals.points,
    })
    .from(teamEventTotals)
    .innerJoin(teams, eq(teams.id, teamEventTotals.teamId))
    .innerJoin(events, eq(events.id, teamEventTotals.eventId))
    .orderBy(asc(teams.name), asc(events.round));
  const byTeam: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    (byTeam[row.name] ??= {})[String(row.round)] = row.points;
  }
  return byTeam;
}

/** The constructors these tests name; any other key is a driver. */
const CONSTRUCTORS = new Set(["red_bull", "rb", "haas"]);

/**
 * An asset's lines in a session as `{ code: points }`. With `subject`, only a
 * constructor's lines that came from that driver.
 */
async function linesOf(
  t: TestDb,
  input: { round: number; kind: string; assetKey: string; subject?: string },
) {
  const { round, kind, assetKey, subject } = input;
  const entityId = await idFor(
    t.db,
    CONSTRUCTORS.has(assetKey) ? "constructor" : "driver",
    assetKey,
  );
  const subjectId = subject && (await idFor(t.db, "driver", subject));
  const rows = await t.db
    .select({
      code: assetScoreLines.ruleCode,
      points: assetScoreLines.points,
      subjectId: assetScoreLines.subjectDriverId,
    })
    .from(assetScoreLines)
    .innerJoin(poolAssets, eq(poolAssets.id, assetScoreLines.assetId))
    .innerJoin(sessions, eq(sessions.id, assetScoreLines.sessionId))
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(
      and(
        eq(events.round, round),
        eq(sessions.kind, kind as "race"),
        sql`coalesce(${poolAssets.driverId}, ${poolAssets.constructorId}) = ${entityId}`,
      ),
    );
  return Object.fromEntries(
    rows
      .filter((row) => subjectId === undefined || row.subjectId === subjectId)
      .map((row) => [row.code, row.points]),
  );
}

describe("the 2026 season scored", () => {
  let t: TestDb;
  let report: Awaited<ReturnType<typeof replayScores2026>>;

  beforeAll(async () => {
    t = await createTestDb();
    report = await replayScores2026(t.db, {
      throughRound: THROUGH,
      actions: [
        {
          at: LEAGUES_AT,
          run: (now, { gameId }) =>
            createTestLeagues(t.db, now, gameId, LEAGUES),
        },
      ],
    });
  }, SEASON_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it("the 2026 season scores with no violations", () => {
    expect(report.violations).toEqual([]);
    const sprints = SPRINT_ROUNDS.filter((round) => round <= THROUGH).length;
    const played = THROUGH - 1;
    expect(report.eventsFinal).toBe(played);
    expect(report.sessionsScored).toBe(2 * played + sprints);
    expect(report.priceUpdates).toBe(played);
    expect(report.runs).toBeGreaterThanOrEqual(report.sessionsScored);
    // The finalize re-checks find every session as its run left it.
    expect(report.skippedRuns).toBeGreaterThanOrEqual(report.sessionsScored);
  });

  it("each scripted team's totals match the expected file", async () => {
    const found = await pointsByRound(t);
    if (process.env.UPDATE_SCORES_EXPECTED) {
      const file = {
        note: "Each scripted team's points per round in the 2026 scoring replay: our own numbers, from the 2026 ruleset and scoring rules. Written by season-scoring.test.ts with UPDATE_SCORES_EXPECTED=1.",
        throughRound: THROUGH,
        teams: found,
      };
      writeFileSync(EXPECTED_PATH, `${JSON.stringify(file, null, 2)}\n`);
    }
    const expected = expectedSchema.parse(
      readFixture("scores-2026-expected.json"),
    );
    expect(expected.throughRound).toBe(THROUGH);
    expect(found).toEqual(expected.teams);

    const summed = Object.fromEntries(
      Object.entries(found).map(([name, rounds]) => [
        name,
        Object.values(rounds).reduce((sum, points) => sum + points, 0),
      ]),
    );
    expect(report.totals).toEqual(summed);
  });

  it("every round's game event ends final, and every window after round 1 opens with formula prices", async () => {
    const calendar = await t.db
      .select({
        round: events.round,
        id: events.id,
        status: gameEvents.status,
      })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .orderBy(asc(events.round));
    const through = calendar.filter((e) => e.round <= THROUGH);
    expect(through).toHaveLength(THROUGH);
    for (const event of through) {
      expect([event.round, event.status]).toEqual([
        event.round,
        event.round === CANCELLED_ROUND ? "cancelled" : "final",
      ]);
    }

    const prices = await t.db.select().from(assetPrices);
    const of = (round: number) => {
      const eventId = calendar.find((e) => e.round === round)!.id;
      return prices.filter((p) => p.eventId === eventId);
    };
    const pool = await t.db.select({ id: poolAssets.id }).from(poolAssets);
    const sources = (round: number) => new Set(of(round).map((p) => p.source));

    expect(sources(1)).toEqual(new Set(["initial"]));
    for (const event of through) {
      if (event.round === 1 || event.round === CANCELLED_ROUND) continue;
      expect(of(event.round)).toHaveLength(pool.length);
      if (event.round === CANCELLED_ROUND + 1) {
        // DM 3.9: prices don't change across a cancellation. The formula
        // priced the cancelled round, and this one takes that list.
        expect(sources(event.round)).toEqual(new Set(["carried"]));
        expect(
          of(event.round)
            .map((p) => [p.assetId, p.price])
            .sort(),
        ).toEqual(
          of(CANCELLED_ROUND)
            .map((p) => [p.assetId, p.price])
            .sort(),
        );
        expect(sources(CANCELLED_ROUND)).toEqual(new Set(["formula"]));
      } else if (event.round === 7) {
        // The script's admin price for two assets stands; the formula did the rest.
        expect(sources(event.round)).toEqual(new Set(["formula", "admin"]));
        expect(
          of(event.round).filter((p) => p.source === "admin"),
        ).toHaveLength(2);
      } else {
        expect([event.round, ...sources(event.round)]).toEqual([
          event.round,
          "formula",
        ]);
      }
    }
    // Round 2's list comes from one update; each update has its own.
    const updates = await t.db.select().from(priceUpdateRuns);
    expect(updates).toHaveLength(report.priceUpdates);
  });

  it("the weekly price moves spread like the official game's", async () => {
    const counts = {
      cheap: { terrible: 0, poor: 0, good: 0, great: 0 },
      expensive: { terrible: 0, poor: 0, good: 0, great: 0 },
    };
    const runs = await t.db.select().from(priceUpdateRuns);
    for (const run of runs) {
      for (const asset of (run.inputs as PriceInputs).assets) {
        if (asset.kept || !asset.tier) continue;
        counts[asset.price >= 185 ? "expensive" : "cheap"][asset.tier]++;
        expect(Math.abs(asset.newPrice - asset.price)).toBeLessThanOrEqual(6);
      }
    }
    for (const band of ["cheap", "expensive"] as const) {
      const tiers = Object.values(counts[band]);
      const total = tiers.reduce((sum, n) => sum + n, 0);
      tiers.forEach((n, tier) => {
        const share = (n / total) * 100;
        expect(
          Math.abs(share - OFFICIAL_TIER_SHARES[band][tier]!),
        ).toBeLessThan(7);
      });
    }
  });

  it("an absent driver's price stands, rounds 12–14", async () => {
    const [hadjar] = await t.db
      .select({ id: poolAssets.id })
      .from(poolAssets)
      .where(eq(poolAssets.driverId, await idFor(t.db, "driver", "hadjar")));
    const rounds = await t.db
      .select({ id: events.id, round: events.round })
      .from(events)
      .where(inArray(events.round, [12, 13, 14]));
    const runs = await t.db
      .select()
      .from(priceUpdateRuns)
      .where(
        inArray(
          priceUpdateRuns.afterEventId,
          rounds.map((round) => round.id),
        ),
      );
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      const entry = (run.inputs as PriceInputs).assets.find(
        (asset) => asset.assetId === hadjar!.id,
      );
      expect(entry).toMatchObject({ absent: true, tier: null, change: 0 });
      expect(entry!.newPrice).toBe(entry!.price);
    }
  });

  it("rounds 12–14 score the substitution", async () => {
    const gameId = await gameOf(t);
    const hadjar = await idFor(t.db, "driver", "hadjar");
    const tsunoda = await idFor(t.db, "driver", "tsunoda");

    // Hadjar has no seat, so no row: the absent penalties, and nothing at Red Bull.
    const hadjarRows = await t.db
      .select({ round: events.round })
      .from(results)
      .innerJoin(sessions, eq(sessions.id, results.sessionId))
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(
        and(eq(results.driverId, hadjar), inArray(events.round, [12, 13, 14])),
      );
    expect(hadjarRows).toEqual([]);
    const qualifying = { "qualifying.not_classified": -5 };
    const race = { "race.not_classified": -20 };
    for (const round of [12, 13, 14]) {
      const on = { round, assetKey: "hadjar" };
      expect(await linesOf(t, { ...on, kind: "qualifying" })).toEqual(
        qualifying,
      );
      expect(await linesOf(t, { ...on, kind: "race" })).toEqual(race);
      for (const kind of ["qualifying", "race"]) {
        expect(
          await linesOf(t, {
            round,
            kind,
            assetKey: "red_bull",
            subject: "hadjar",
          }),
        ).toEqual({});
      }
    }
    expect(
      await linesOf(t, { round: 12, kind: "sprint", assetKey: "hadjar" }),
    ).toEqual({ "sprint.not_classified": -10 });

    // His owners take them: the team that kept him, at round 12.
    const [keeper] = await t.db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.name, "Keeps a withdrawn driver"));
    const base = await t.db
      .select({ points: teamBaseLines.points })
      .from(teamBaseLines)
      .innerJoin(poolAssets, eq(poolAssets.id, teamBaseLines.assetId))
      .innerJoin(sessions, eq(sessions.id, teamBaseLines.sessionId))
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(
        and(
          eq(teamBaseLines.teamId, keeper!.id),
          eq(poolAssets.driverId, hadjar),
          eq(events.round, 12),
        ),
      );
    expect(base.map((b) => b.points).sort((a, b) => a - b)).toEqual([
      -20, -10, -5,
    ]);

    // Lawson's points go to Red Bull, as they are on his own asset, and not to
    // Racing Bulls.
    const lawson: Array<[number, string, Record<string, number>]> = [
      [12, "qualifying", { "qualifying.position": 3 }],
      [12, "race", { "race.position": 6, "race.positions": 1 }],
      [13, "race", { "race.positions": 8 }],
      [14, "qualifying", { "qualifying.position": 3 }],
      [14, "race", { "race.position": 8, "race.positions": 2 }],
    ];
    for (const [round, kind, lines] of lawson) {
      expect(await linesOf(t, { round, kind, assetKey: "lawson" })).toEqual(
        lines,
      );
      expect(
        await linesOf(t, {
          round,
          kind,
          assetKey: "red_bull",
          subject: "lawson",
        }),
      ).toEqual(lines);
      expect(
        await linesOf(t, { round, kind, assetKey: "rb", subject: "lawson" }),
      ).toEqual({});
    }

    // Tsunoda isn't priced: no asset, and his points are in Racing Bulls'
    // aggregate by `subject_driver_id`.
    expect(
      await t.db
        .select()
        .from(poolAssets)
        .where(
          and(eq(poolAssets.gameId, gameId), eq(poolAssets.driverId, tsunoda)),
        ),
    ).toEqual([]);
    const tsunodaLines: Array<[number, string, Record<string, number>]> = [
      [12, "sprint", { "sprint.positions": -1 }],
      [12, "race", { "race.positions": 1 }],
      [13, "race", { "race.position": 1, "race.positions": 5 }],
      [14, "race", { "race.positions": 1 }],
    ];
    for (const [round, kind, lines] of tsunodaLines) {
      expect(
        await linesOf(t, { round, kind, assetKey: "rb", subject: "tsunoda" }),
      ).toEqual(lines);
    }
  });

  it("the cancel wins: round 4 has real results, and is neither polled in nor scored", async () => {
    const [round4] = await t.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.round, CANCELLED_ROUND));
    const own = await t.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.eventId, round4!.id));
    const ids = own.map((s) => s.id);
    expect(
      await t.db.select().from(results).where(inArray(results.sessionId, ids)),
    ).toEqual([]);
    expect(
      await t.db
        .select()
        .from(scoringRuns)
        .where(inArray(scoringRuns.sessionId, ids)),
    ).toEqual([]);
    expect(
      await t.db
        .select()
        .from(teamEventTotals)
        .where(eq(teamEventTotals.eventId, round4!.id)),
    ).toEqual([]);
  });

  it("the drivers staff entered at rounds 1 and 14 take no-time penalties, which count for their constructors", async () => {
    const cases: Array<[number, string, string]> = [
      [1, "max_verstappen", "red_bull"],
      [14, "bearman", "haas"],
    ];
    const noTime = { "qualifying.not_classified": -5 };
    for (const [round, driver, constructor] of cases) {
      const on = { round, kind: "qualifying" };
      expect(await linesOf(t, { ...on, assetKey: driver })).toEqual(noTime);
      expect(
        await linesOf(t, { ...on, assetKey: constructor, subject: driver }),
      ).toEqual(noTime);
    }
  });

  it("round 19 scores what staff did: Hirakawa for Ocon, and Lawson disqualified", async () => {
    const on = (kind: string) => ({ round: 19, kind });
    expect(await linesOf(t, { ...on("qualifying"), assetKey: "ocon" })).toEqual(
      {
        "qualifying.not_classified": -5,
      },
    );
    expect(await linesOf(t, { ...on("race"), assetKey: "ocon" })).toEqual({
      "race.not_classified": -20,
    });
    expect(
      await linesOf(t, {
        ...on("race"),
        assetKey: "haas",
        subject: "ryo_hirakawa",
      }),
    ).toEqual({ "race.position": 1, "race.positions": 8 });

    // Disqualified, a driver costs the constructor twice: his line, copied,
    // and the constructor's own.
    expect(
      await linesOf(t, { ...on("qualifying"), assetKey: "lawson" }),
    ).toEqual({ "qualifying.not_classified": -5 });
    expect(
      await linesOf(t, {
        ...on("qualifying"),
        assetKey: "rb",
        subject: "lawson",
      }),
    ).toEqual({
      "qualifying.not_classified": -5,
      "qualifying.disqualified": -5,
    });
  });

  it("the ledger check catches a bad line on a driver who isn't in the pool", async () => {
    const gameId = await gameOf(t);
    const tsunoda = await idFor(t.db, "driver", "tsunoda");
    let found: string[] = [];
    await t.db
      .transaction(async (tx) => {
        await tx
          .update(assetScoreLines)
          .set({ points: sql`${assetScoreLines.points} + 1` })
          .where(eq(assetScoreLines.subjectDriverId, tsunoda));
        found = await checkScoringLedger(tx, gameId);
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    expect(found).toContainEqual(
      expect.stringMatching(
        /round 12 sprint: .*sprint\.positions .* at 0, not in the pool, recount -1/,
      ),
    );
  });
});

/** What a late change may and may not touch. */
async function snapshot(t: TestDb) {
  const totals = await t.db
    .select({
      teamId: teamEventTotals.teamId,
      round: events.round,
      points: teamEventTotals.points,
      pointsBySession: teamEventTotals.pointsBySession,
      cumulative: teamEventTotals.cumulativePoints,
    })
    .from(teamEventTotals)
    .innerJoin(events, eq(events.id, teamEventTotals.eventId))
    .orderBy(asc(events.round), asc(teamEventTotals.teamId));
  const tables = await t.db
    .select({
      league: leagues.name,
      teamId: leagueStandings.teamId,
      points: leagueStandings.points,
    })
    .from(leagueStandings)
    .innerJoin(leagues, eq(leagues.id, leagueStandings.leagueId))
    .orderBy(asc(leagues.name), asc(leagueStandings.teamId));
  const prices = await t.db
    .select({
      assetId: assetPrices.assetId,
      eventId: assetPrices.eventId,
      price: assetPrices.price,
      source: assetPrices.source,
    })
    .from(assetPrices)
    .orderBy(asc(assetPrices.eventId), asc(assetPrices.assetId));
  const updates = await t.db.select().from(priceUpdateRuns);
  const hadjar = await linesOf(t, {
    round: 5,
    kind: "race",
    assetKey: "hadjar",
  });
  return { totals, tables, prices, updates: updates.length, hadjar };
}

describe("a late stewards' penalty ripples", () => {
  const PENALTY_ROUND = 5;
  /** Half an hour after round 7's +48 h finalize. */
  const PENALTY_AT = "2026-06-16T15:30:00Z";

  let t: TestDb;
  let report: Awaited<ReturnType<typeof replayScores2026>>;
  let before: Awaited<ReturnType<typeof snapshot>>;
  let after: Awaited<ReturnType<typeof snapshot>>;
  let round7Status: string | undefined;

  beforeAll(async () => {
    t = await createTestDb();
    report = await replayScores2026(t.db, {
      throughRound: 7,
      actions: [
        {
          at: LEAGUES_AT,
          run: (now, { gameId }) =>
            createTestLeagues(t.db, now, gameId, LEAGUES),
        },
        {
          at: PENALTY_AT,
          run: async (now) => {
            const [round7] = await t.db
              .select({ status: gameEvents.status })
              .from(gameEvents)
              .innerJoin(events, eq(events.id, gameEvents.eventId))
              .where(eq(events.round, 7));
            round7Status = round7?.status;
            before = await snapshot(t);
            await lateStewardsPenalty(t.db, now, {
              round: PENALTY_ROUND,
              driver: "hadjar",
              seconds: 30,
              reason: "30 s post-race penalty, after round 7 was scored",
            });
          },
        },
      ],
    });
    after = await snapshot(t);
  }, SEASON_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  const row = (snap: typeof before, teamId: string, round: number) =>
    snap.totals.find((r) => r.teamId === teamId && r.round === round);
  const teamsAt = (round: number) =>
    before.totals.filter((r) => r.round === round).map((r) => r.teamId);

  it("lands after round 7 is final, and moves the driver down", () => {
    expect(round7Status).toBe("final");
    expect(before.hadjar).toEqual({ "race.position": 10, "race.positions": 2 });
    // P5 to P8 from P7 on the grid.
    expect(after.hadjar).toEqual({ "race.position": 4, "race.positions": -1 });
  });

  it("changes round 5's points for every team that played it, and leaves the checks clean", () => {
    expect(report.violations).toEqual([]);
    expect(teamsAt(PENALTY_ROUND).length).toBeGreaterThan(0);
    for (const teamId of teamsAt(PENALTY_ROUND)) {
      expect(row(after, teamId, PENALTY_ROUND)!.points).not.toBe(
        row(before, teamId, PENALTY_ROUND)!.points,
      );
    }
  });

  it("moves every later running total by the same amount", () => {
    for (const teamId of teamsAt(PENALTY_ROUND)) {
      const delta =
        row(after, teamId, PENALTY_ROUND)!.points -
        row(before, teamId, PENALTY_ROUND)!.points;
      for (const round of [PENALTY_ROUND, 6, 7]) {
        expect(row(after, teamId, round)!.cumulative).toBe(
          row(before, teamId, round)!.cumulative + delta,
        );
      }
    }
  });

  it("changes no other event's points", () => {
    const others = (snap: typeof before) =>
      snap.totals
        .filter((r) => r.round !== PENALTY_ROUND)
        .map(({ teamId, round, points, pointsBySession }) => ({
          teamId,
          round,
          points,
          pointsBySession,
        }));
    expect(others(before).length).toBeGreaterThan(0);
    expect(others(after)).toEqual(others(before));
    // Nothing before it moves at all, and a team that didn't play it stays.
    const earlier = (snap: typeof before) =>
      snap.totals.filter((r) => r.round < PENALTY_ROUND);
    expect(earlier(after)).toEqual(earlier(before));
    const played = new Set(teamsAt(PENALTY_ROUND));
    const notPlayed = (snap: typeof before) =>
      snap.totals.filter((r) => !played.has(r.teamId));
    expect(notPlayed(before).length).toBeGreaterThan(0);
    expect(notPlayed(after)).toEqual(notPlayed(before));
  });

  it("changes the league tables that hold round 5, and no other", () => {
    const table = (snap: typeof before, league: string) =>
      snap.tables.filter((r) => r.league === league);
    for (const league of ["Whole season", "Rounds 5 to 10"]) {
      const tableBefore = table(before, league);
      expect(tableBefore.length).toBeGreaterThan(0);
      for (const entry of tableBefore) {
        const moved = table(after, league).find(
          (r) => r.teamId === entry.teamId,
        )!;
        const delta =
          (row(after, entry.teamId, PENALTY_ROUND)?.points ?? 0) -
          (row(before, entry.teamId, PENALTY_ROUND)?.points ?? 0);
        expect(moved.points).toBe(entry.points + delta);
      }
    }
    expect(table(before, "From round 6").length).toBeGreaterThan(0);
    expect(table(after, "From round 6")).toEqual(table(before, "From round 6"));
  });

  it("leaves prices alone", () => {
    expect(after.prices).toEqual(before.prices);
    expect(after.updates).toBe(before.updates);
  });
});
