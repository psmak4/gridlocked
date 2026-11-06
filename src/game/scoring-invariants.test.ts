import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { createTestDb } from "../../tests/helpers/test-db";
import { idFor } from "../../tests/helpers/ingest-2026";
import {
  createTestLeagues,
  replayScores2026,
} from "../../tests/helpers/replay-2026";
import {
  assetScoreLines,
  events,
  games,
  leagueMemberships,
  leagues,
  leagueStandings,
  poolAssets,
  results,
  scoringRuns,
  sessionResultState,
  sessions,
  teamAdjustmentLines,
  teamEventStates,
  teamEventTotals,
  teams,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import {
  checkScoringInvariants,
  checkScoringLedger,
} from "./scoring-invariants";

// The scoring invariants (Task 10), each shown to catch a hand-broken row. One
// game is built once: rounds 1 and 2 of the scored season, which hold a sprint
// weekend, a Late Call and an x3 Boost, with two leagues. Each case writes its
// bad row in a transaction, checks, and rolls back, so the next case starts
// from the clean game. A bad line on a driver not in the pool needs a
// substitute, so that case is in season-scoring.test.ts.

const NOW = new Date("2026-03-20T09:00:00.000Z");
const THROUGH = 2;

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
type Tx = Parameters<Parameters<TestDb["db"]["transaction"]>[0]>[0];

describe("checkScoringInvariants", () => {
  let t: TestDb;
  let gameId: string;
  let round1: string;
  let round2: string;
  let teamId: string;
  let chipTeamId: string;
  let season: string;
  let raceOf2: string;
  let qualifyingOf1: string;

  /** The ledger check over the game with `breakIt` done, then rolled back. */
  async function ledgerWith(breakIt: (tx: Tx) => Promise<void>) {
    let found: string[] = [];
    await t.db
      .transaction(async (tx) => {
        await breakIt(tx);
        found = await checkScoringLedger(tx, gameId);
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    return found;
  }

  const expectFound = (found: string[], message: RegExp) =>
    expect(found).toContainEqual(expect.stringMatching(message));

  const totalsRow = (team: string, event: string) =>
    and(eq(teamEventTotals.teamId, team), eq(teamEventTotals.eventId, event));

  beforeAll(async () => {
    t = await createTestDb();
    await replayScores2026(t.db, {
      throughRound: THROUGH,
      actions: [
        {
          at: "2026-03-06T23:00:00Z",
          run: (now, ctx) =>
            createTestLeagues(t.db, now, ctx.gameId, {
              Season: [1],
              "Round 2 on": [2],
            }),
        },
      ],
    });
    const [game] = await t.db.select({ id: games.id }).from(games);
    gameId = game!.id;
    const eventOf = async (round: number) => {
      const [event] = await t.db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.round, round));
      return event!.id;
    };
    round1 = await eventOf(1);
    round2 = await eventOf(2);
    const named = await t.db
      .select({ id: teams.id, name: teams.name })
      .from(teams);
    teamId = named.find((team) => team.name === "One a week")!.id;
    chipTeamId = named.find((team) => team.name === "Chip collector")!.id;
    const [league] = await t.db
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.name, "Season"));
    season = league!.id;
    const sessionOf = async (eventId: string, kind: "race" | "qualifying") => {
      const [session] = await t.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.eventId, eventId), eq(sessions.kind, kind)));
      return session!.id;
    };
    raceOf2 = await sessionOf(round2, "race");
    qualifyingOf1 = await sessionOf(round1, "qualifying");
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it("finds nothing wrong with a scored game", async () => {
    expect(await checkScoringInvariants(t.db, gameId, { now: NOW })).toEqual(
      [],
    );
  });

  describe("a total is base plus adjustments", () => {
    it("catches a total edited by hand", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventTotals)
          .set({ points: sql`${teamEventTotals.points} + 1` })
          .where(totalsRow(teamId, round2));
      });
      expectFound(found, /round 2 team .*: points .*, recount/);
    });

    it("catches an adjustment line no total counts", async () => {
      const found = await ledgerWith(async (tx) => {
        const [run] = await tx
          .select({ id: scoringRuns.id })
          .from(scoringRuns)
          .where(eq(scoringRuns.sessionId, raceOf2));
        await tx.insert(teamAdjustmentLines).values({
          id: newId(),
          gameId,
          teamId,
          eventId: round2,
          sessionId: raceOf2,
          lineType: "transfer_penalty",
          points: -10,
          runId: run!.id,
        });
      });
      expectFound(found, /round 2 team .*: points .*, recount/);
    });

    it("catches a base line that moved", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(assetScoreLines)
          .set({ points: sql`${assetScoreLines.points} + 2` })
          .where(eq(assetScoreLines.sessionId, raceOf2));
      });
      expectFound(found, /round 2 team .*: points .*, recount/);
    });

    it("catches a session's entry that disagrees", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventTotals)
          .set({
            pointsBySession: sql`jsonb_set(${teamEventTotals.pointsBySession}, ${`{${raceOf2}}`}, '12345')`,
          })
          .where(totalsRow(teamId, round2));
      });
      expectFound(found, /round 2 team .*: session .* has 12345, recount/);
    });

    it("catches a lock record with no total, and a total with no lock record", async () => {
      const missing = await ledgerWith(async (tx) => {
        await tx.delete(teamEventTotals).where(totalsRow(teamId, round2));
      });
      expectFound(missing, /round 2 team .*: no totals row/);
      const stray = await ledgerWith(async (tx) => {
        await tx
          .delete(teamEventStates)
          .where(
            and(
              eq(teamEventStates.teamId, chipTeamId),
              eq(teamEventStates.eventId, round2),
            ),
          );
      });
      expectFound(stray, /round 2 team .*: a totals row with no lock record/);
    });

    it("counts the Late Call lineup from the race on, and the locked one before it", async () => {
      // The clean game passes only if the recount follows `final_fix_version_id`,
      // so show that the team has one, and that the recount reads it.
      const [state] = await t.db
        .select({ finalFix: teamEventStates.finalFixVersionId })
        .from(teamEventStates)
        .where(
          and(
            eq(teamEventStates.teamId, chipTeamId),
            eq(teamEventStates.eventId, round2),
          ),
        );
      expect(state!.finalFix).not.toBeNull();
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventStates)
          .set({ finalFixVersionId: null })
          .where(
            and(
              eq(teamEventStates.teamId, chipTeamId),
              eq(teamEventStates.eventId, round2),
            ),
          );
      });
      expectFound(found, /round 2 team .*: points .*, recount/);
    });
  });

  describe("running totals, firsts and ranks match a recount", () => {
    it("catches a running total", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventTotals)
          .set({
            cumulativePoints: sql`${teamEventTotals.cumulativePoints} + 1`,
          })
          .where(totalsRow(teamId, round2));
      });
      expectFound(found, /round 2 team .*: running total .*, recount/);
    });

    it("catches a first-reached sequence", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventTotals)
          .set({
            firstReachedSequence: sql`3 - ${teamEventTotals.firstReachedSequence}`,
          })
          .where(totalsRow(teamId, round2));
      });
      expectFound(found, /round 2 team .*: first reached .*, recount/);
    });

    it("catches a rank", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventTotals)
          .set({ globalRank: sql`${teamEventTotals.globalRank} + 20` })
          .where(totalsRow(teamId, round2));
      });
      expectFound(found, /round 2 team .*: rank .*, recount/);
    });

    it("catches a status that doesn't follow the game event", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(teamEventTotals)
          .set({ status: "provisional" })
          .where(totalsRow(teamId, round2));
      });
      expectFound(found, /round 2 team .*: status provisional, recount final/);
    });
  });

  describe("every league table matches a recount", () => {
    const standing = (team: string) =>
      and(
        eq(leagueStandings.leagueId, season),
        eq(leagueStandings.teamId, team),
      );

    it("catches points", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(leagueStandings)
          .set({ points: sql`${leagueStandings.points} + 1` })
          .where(standing(teamId));
      });
      expectFound(found, /league .* team .*: points .*, recount/);
    });

    it("catches a tiebreak and a rank", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(leagueStandings)
          .set({
            firstReachedSequence: sql`3 - ${leagueStandings.firstReachedSequence}`,
            rank: sql`${leagueStandings.rank} + 20`,
          })
          .where(standing(teamId));
      });
      expectFound(found, /league .* team .*: first reached .*, recount/);
      expectFound(found, /league .* team .*: rank .*, recount/);
    });

    it("catches the through event and the status", async () => {
      const found = await ledgerWith(async (tx) => {
        await tx
          .update(leagueStandings)
          .set({ throughEventId: round1, status: "provisional" })
          .where(standing(teamId));
      });
      expectFound(found, /league .* team .*: through round 1, recount round 2/);
      expectFound(
        found,
        /league .* team .*: status provisional, recount final/,
      );
    });

    it("catches a missing row, and the row of a team that left", async () => {
      const missing = await ledgerWith(async (tx) => {
        await tx.delete(leagueStandings).where(standing(teamId));
      });
      expectFound(missing, /league .* team .*: no row in the table/);
      const left = await ledgerWith(async (tx) => {
        await tx
          .update(leagueMemberships)
          .set({ leftAt: NOW })
          .where(
            and(
              eq(leagueMemberships.leagueId, season),
              eq(leagueMemberships.teamId, teamId),
              isNull(leagueMemberships.leftAt),
            ),
          );
      });
      expectFound(left, /league .* team .*: a row for a team not in the table/);
    });
  });

  describe("every constructor is its drivers plus its own lines", () => {
    const assetOf = async (
      tx: Tx,
      key: string,
      type: "driver" | "constructor",
    ) => {
      const id = await idFor(tx, type, key);
      const [asset] = await tx
        .select({ id: poolAssets.id })
        .from(poolAssets)
        .where(
          type === "driver"
            ? eq(poolAssets.driverId, id)
            : eq(poolAssets.constructorId, id),
        );
      return asset!.id;
    };

    it("catches a copied line that differs from the driver's", async () => {
      const found = await ledgerWith(async (tx) => {
        const verstappen = await idFor(tx, "driver", "max_verstappen");
        await tx
          .update(assetScoreLines)
          .set({ points: sql`${assetScoreLines.points} + 1` })
          .where(
            and(
              eq(assetScoreLines.sessionId, raceOf2),
              eq(assetScoreLines.subjectDriverId, verstappen),
            ),
          );
      });
      expectFound(
        found,
        /round 2 race: .* has race\..* for .*, the driver has/,
      );
    });

    it("catches a driver's line that wasn't copied", async () => {
      const found = await ledgerWith(async (tx) => {
        const asset = await assetOf(tx, "max_verstappen", "driver");
        await tx.insert(assetScoreLines).values({
          id: newId(),
          gameId,
          sessionId: raceOf2,
          runId: (
            await tx
              .select({ id: scoringRuns.id })
              .from(scoringRuns)
              .where(
                and(
                  eq(scoringRuns.sessionId, raceOf2),
                  eq(scoringRuns.isCurrent, true),
                ),
              )
          )[0]!.id,
          assetId: asset,
          ruleCode: "race.fastest_lap",
          category: "race_fastest_lap",
          points: 10,
          detail: {},
        });
      });
      expectFound(
        found,
        /round 2 race: .* has no race\.fastest_lap for .*, the driver has 10/,
      );
    });

    it("catches a line from a driver who isn't the constructor's", async () => {
      const found = await ledgerWith(async (tx) => {
        const verstappen = await idFor(tx, "driver", "max_verstappen");
        const haas = await idFor(tx, "constructor", "haas");
        await tx
          .update(results)
          .set({ constructorId: haas })
          .where(
            and(
              eq(results.sessionId, raceOf2),
              eq(results.driverId, verstappen),
            ),
          );
      });
      expectFound(
        found,
        /round 2 race: .* a line from .*, who has no result for it/,
      );
    });

    it("catches a disqualified driver's penalty that is missing, and one with no cause", async () => {
      const missing = await ledgerWith(async (tx) => {
        const verstappen = await idFor(tx, "driver", "max_verstappen");
        await tx
          .update(results)
          .set({ classification: "disqualified" })
          .where(
            and(
              eq(results.sessionId, raceOf2),
              eq(results.driverId, verstappen),
            ),
          );
      });
      expectFound(
        missing,
        /round 2 race: .* has no race\.disqualified for .*, expected -20/,
      );
      const stray = await ledgerWith(async (tx) => {
        const asset = await assetOf(tx, "red_bull", "constructor");
        const verstappen = await idFor(tx, "driver", "max_verstappen");
        const [run] = await tx
          .select({ id: scoringRuns.id })
          .from(scoringRuns)
          .where(
            and(
              eq(scoringRuns.sessionId, raceOf2),
              eq(scoringRuns.isCurrent, true),
            ),
          );
        await tx.insert(assetScoreLines).values({
          id: newId(),
          gameId,
          sessionId: raceOf2,
          runId: run!.id,
          assetId: asset,
          ruleCode: "race.disqualified",
          category: "race_penalty",
          subjectDriverId: verstappen,
          points: -20,
          detail: {},
        });
      });
      expectFound(
        stray,
        /round 2 race: .* race\.disqualified for .*, who isn't listed/,
      );
    });

    it("catches a constructor's own line with a subject, or none where one belongs", async () => {
      const found = await ledgerWith(async (tx) => {
        const asset = await assetOf(tx, "red_bull", "constructor");
        await tx
          .update(assetScoreLines)
          .set({ subjectDriverId: null })
          .where(
            and(
              eq(assetScoreLines.sessionId, raceOf2),
              eq(assetScoreLines.assetId, asset),
              eq(assetScoreLines.ruleCode, "race.position"),
            ),
          );
      });
      expectFound(found, /round 2 race: .* race\.position has no driver/);
      const own = await ledgerWith(async (tx) => {
        const verstappen = await idFor(tx, "driver", "max_verstappen");
        const asset = await assetOf(tx, "red_bull", "constructor");
        await tx
          .update(assetScoreLines)
          .set({ subjectDriverId: verstappen })
          .where(
            and(
              eq(assetScoreLines.sessionId, qualifyingOf1),
              eq(assetScoreLines.assetId, asset),
              eq(assetScoreLines.ruleCode, "qualifying.knockout"),
            ),
          );
      });
      expectFound(
        own,
        /round 1 qualifying: .* qualifying\.knockout names a driver/,
      );
    });
  });

  describe("a forced re-score of every session changes nothing", () => {
    it("catches results that changed under the lines", async () => {
      let found: string[] = [];
      await t.db
        .transaction(async (tx) => {
          const winner = await idFor(tx, "driver", "antonelli");
          await tx
            .update(results)
            .set({ position: 19 })
            .where(
              and(eq(results.sessionId, raceOf2), eq(results.driverId, winner)),
            );
          found = await checkScoringInvariants(tx, gameId, {
            now: NOW,
          });
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      expectFound(found, /a forced re-score changes asset_score_lines/);
      expectFound(found, /a forced re-score changes team_event_totals/);
      expectFound(found, /a forced re-score changes league_standings/);
    });

    it("catches a session with a current run that the re-score can't reach", async () => {
      let found: string[] = [];
      await t.db
        .transaction(async (tx) => {
          await tx
            .update(sessionResultState)
            .set({ status: "under_review" })
            .where(eq(sessionResultState.sessionId, raceOf2));
          found = await checkScoringInvariants(tx, gameId, { now: NOW });
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      expectFound(
        found,
        /a forced re-score reached 4 of the 5 sessions with a current run/,
      );
    });

    it("catches a game the re-score reaches nothing in", async () => {
      let found: string[] = [];
      await t.db
        .transaction(async (tx) => {
          await tx
            .update(games)
            .set({ status: "completed" })
            .where(eq(games.id, gameId));
          found = await checkScoringInvariants(tx, gameId, { now: NOW });
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      expectFound(
        found,
        /a forced re-score reached 0 of the 5 sessions with a current run/,
      );
    });

    it("leaves the game as it was", async () => {
      const state = async () => ({
        runs: await t.db
          .select({ id: scoringRuns.id, current: scoringRuns.isCurrent })
          .from(scoringRuns)
          .orderBy(asc(scoringRuns.id)),
        lines: (await t.db.select({ n: count() }).from(assetScoreLines))[0]!.n,
        totals: await t.db
          .select()
          .from(teamEventTotals)
          .orderBy(asc(teamEventTotals.teamId), asc(teamEventTotals.eventId)),
      });
      const before = await state();
      await checkScoringInvariants(t.db, gameId, { now: NOW });
      expect(await state()).toEqual(before);
    });
  });
});
