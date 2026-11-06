import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import {
  assetScoreLines,
  effectiveResults,
  events,
  gameEvents,
  leagueMemberships,
  leagues,
  leagueStandings,
  lineupPicks,
  lineupVersions,
  poolAssets,
  scoringRules,
  scoringRuns,
  sessions,
  teamAdjustmentLines,
  teamEventStates,
  teamEventTotals,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { recomputeStandings } from "@/leagues/standings";
import { scoringRuleSchema, type ScoringRule } from "@/scoring/rules";
import { scoredSessions } from "./score-jobs";
import {
  finishRun,
  startRun,
  writeAssetLines,
  writeTeamAdjustments,
} from "./scoring-runs";
import { recomputeTotals } from "./totals";

// The scoring rules checked over what a season left behind (M4 Task 10), for
// the replay and for any game. Totals and tables are worked out again here, in
// TypeScript, from the rows they were made from (the lock records, lineups,
// score lines and memberships), rather than by the SQL that wrote them, so a
// mistake there shows up as a difference. Reads results only through
// `effective_results`.

const SCORED_OR_FINAL = new Set(["scored", "final"]);

type Result = typeof effectiveResults.$inferSelect;
type Line = typeof assetScoreLines.$inferSelect;
type DriverRule = Extract<ScoringRule, { target: "driver" }>;

/** `(scheduled_start, id)`: the order Late Call counts sessions in. */
const atOrAfter = (
  a: { start: Date; id: string },
  b: { start: Date; id: string },
) =>
  a.start.getTime() > b.start.getTime() ||
  (a.start.getTime() === b.start.getTime() && a.id >= b.id);

/** A table's row sets as the same text, whatever order they came in. */
const canonical = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).sort();

/**
 * Ranks entries by `score` descending then `first` ascending, sharing a rank
 * on a full tie, as `rank()` does.
 */
function ranks<T extends { score: number; first: number }>(entries: T[]) {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.first - b.first,
  );
  const out = new Map<T, number>();
  sorted.forEach((entry, i) => {
    const previous = sorted[i - 1];
    const tied =
      previous?.score === entry.score && previous.first === entry.first;
    out.set(entry, tied ? out.get(previous)! : i + 1);
  });
  return out;
}

/**
 * What a driver rule scores for a result row, or null if it scores nothing:
 * the recount for a driver with no asset, whose lines exist only on his
 * constructor. 0 is no line.
 */
function recountDriverRule(
  rule: DriverRule,
  row: Result,
  rowCount: number,
): number | null {
  const position = row.classification === "classified" ? row.position : null;
  const points = (() => {
    switch (rule.kind) {
      case "position_table":
        return position === null
          ? null
          : (rule.params.points[position - 1] ?? 0);
      case "positions_delta": {
        const grid = row.pitLaneStart ? rowCount : row.grid;
        if (position === null || grid === null) return null;
        const gained = (grid - position) * rule.params.perPosition;
        return rule.params.lostCap === null
          ? gained
          : Math.max(gained, rule.params.lostCap);
      }
      case "classification_penalty":
        return rule.params.classifications.includes(row.classification) ||
          (rule.params.noTime && row.q1Ms === null)
          ? rule.params.points
          : null;
      case "flag_bonus":
        return position !== null && row.fastestLapRank === 1
          ? rule.params.points
          : null;
    }
  })();
  return points === 0 ? null : points;
}

/**
 * Checks the scores a game holds and returns one message per violation, empty
 * when there are none. Reads only:
 * - every team's total for an event (`team_event_totals`) equals its base
 *   lines, from its effective lineup session by session, plus its adjustment
 *   lines, in `points` and in each `points_by_session` entry, and a lock
 *   record in a scored event has a total, and only then;
 * - its running total, `first_reached_sequence`, `global_rank` and status
 *   match a recount over the team's rows and the game's rows at the event;
 * - every active league's table but `global`, which has none, matches a
 *   recount over its range and its current active members: points, tiebreak,
 *   rank, through event and status. `previous_rank` isn't recounted, since
 *   the table it came from is gone;
 * - every constructor's lines are its drivers' plus its own. Each driver with
 *   a result naming it has each of his lines copied, under his id: an asset's
 *   lines, or a recount from the rules for a driver not in the pool; a line
 *   names a driver with a result for it, and no other; a listed driver's
 *   penalty is there as the constructor's own line too (a disqualified driver
 *   costs it twice, on purpose); a stage line names nobody.
 */
export async function checkScoringLedger(
  db: Db,
  gameId: string,
): Promise<string[]> {
  const found: string[] = [];

  // --- What the game has --------------------------------------------------
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
      rulesetVersionId: gameEvents.rulesetVersionId,
      round: events.round,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(events.round));
  const eventOf = new Map(calendar.map((e) => [e.eventId, e]));
  const eventIds = calendar.map((e) => e.eventId);

  const allSessions = await db
    .select({
      id: sessions.id,
      eventId: sessions.eventId,
      kind: sessions.kind,
      start: sessions.scheduledStart,
    })
    .from(sessions)
    .where(inArray(sessions.eventId, eventIds));
  const sessionOf = new Map(allSessions.map((s) => [s.id, s]));

  const current = new Set(
    (
      await db
        .select({ sessionId: scoringRuns.sessionId })
        .from(scoringRuns)
        .where(
          and(eq(scoringRuns.gameId, gameId), eq(scoringRuns.isCurrent, true)),
        )
    ).map((run) => run.sessionId),
  );
  const scored = allSessions.filter((s) => current.has(s.id));

  const lines = await db
    .select()
    .from(assetScoreLines)
    .where(eq(assetScoreLines.gameId, gameId));
  const linesAt = new Map<string, Line[]>();
  const pointsAt = new Map<string, number>();
  for (const line of lines) {
    const key = `${line.sessionId}/${line.assetId}`;
    linesAt.set(key, [...(linesAt.get(key) ?? []), line]);
    pointsAt.set(key, (pointsAt.get(key) ?? 0) + line.points);
  }

  const states = await db
    .select()
    .from(teamEventStates)
    .where(eq(teamEventStates.gameId, gameId));
  const versionIds = states.flatMap((s) =>
    s.finalFixVersionId
      ? [s.lockedVersionId, s.finalFixVersionId]
      : [s.lockedVersionId],
  );
  const picks =
    versionIds.length === 0
      ? []
      : await db
          .select({
            versionId: lineupPicks.lineupVersionId,
            assetId: lineupPicks.assetId,
          })
          .from(lineupPicks)
          .where(inArray(lineupPicks.lineupVersionId, versionIds));
  const picksOf = new Map<string, string[]>();
  for (const pick of picks) {
    picksOf.set(pick.versionId, [
      ...(picksOf.get(pick.versionId) ?? []),
      pick.assetId,
    ]);
  }
  const fromSession = new Map(
    (
      await db
        .select({
          id: lineupVersions.id,
          from: lineupVersions.effectiveFromSessionId,
        })
        .from(lineupVersions)
        .innerJoin(teams, eq(teams.id, lineupVersions.teamId))
        .where(eq(teams.gameId, gameId))
    ).map((v) => [v.id, v.from]),
  );

  const adjustments = await db
    .select()
    .from(teamAdjustmentLines)
    .where(eq(teamAdjustmentLines.gameId, gameId));
  const adjustedAt = new Map<string, number>();
  for (const line of adjustments) {
    const key = `${line.teamId}/${line.eventId}/${line.sessionId ?? "event"}`;
    adjustedAt.set(key, (adjustedAt.get(key) ?? 0) + line.points);
  }

  const totals = await db
    .select()
    .from(teamEventTotals)
    .where(eq(teamEventTotals.gameId, gameId));
  const totalOf = new Map(totals.map((t) => [`${t.teamId}/${t.eventId}`, t]));
  const stateOf = new Set(states.map((s) => `${s.teamId}/${s.eventId}`));

  // --- A total is base plus adjustments -----------------------------------
  for (const state of states) {
    const event = eventOf.get(state.eventId);
    if (!event || !SCORED_OR_FINAL.has(event.status)) continue;
    const at = `round ${event.round} team ${state.teamId}`;
    const total = totalOf.get(`${state.teamId}/${state.eventId}`);
    if (!total) {
      found.push(`${at}: no totals row for its lock record`);
      continue;
    }
    const lateCallFrom =
      state.finalFixVersionId === null
        ? undefined
        : sessionOf.get(fromSession.get(state.finalFixVersionId) ?? "");
    const bySession: Record<string, number> = {};
    for (const session of scored.filter((s) => s.eventId === state.eventId)) {
      const version =
        lateCallFrom && atOrAfter(session, lateCallFrom)
          ? state.finalFixVersionId!
          : state.lockedVersionId;
      const base = (picksOf.get(version) ?? []).reduce(
        (sum, assetId) => sum + (pointsAt.get(`${session.id}/${assetId}`) ?? 0),
        0,
      );
      bySession[session.id] =
        base +
        (adjustedAt.get(`${state.teamId}/${state.eventId}/${session.id}`) ?? 0);
    }
    const recount =
      Object.values(bySession).reduce((sum, points) => sum + points, 0) +
      (adjustedAt.get(`${state.teamId}/${state.eventId}/event`) ?? 0);
    if (total.points !== recount) {
      found.push(`${at}: points ${total.points}, recount ${recount}`);
    }
    const stored = total.pointsBySession as Record<string, number>;
    for (const sessionId of new Set([
      ...Object.keys(stored),
      ...Object.keys(bySession),
    ])) {
      if (stored[sessionId] !== bySession[sessionId]) {
        found.push(
          `${at}: session ${sessionId} has ${stored[sessionId]}, recount ${bySession[sessionId]}`,
        );
      }
    }
  }
  for (const total of totals) {
    if (!stateOf.has(`${total.teamId}/${total.eventId}`)) {
      const round = eventOf.get(total.eventId)?.round;
      found.push(
        `round ${round} team ${total.teamId}: a totals row with no lock record`,
      );
    }
  }

  // --- Running totals, firsts, ranks and status ---------------------------
  const byTeam = new Map<string, typeof totals>();
  for (const total of totals) {
    byTeam.set(total.teamId, [...(byTeam.get(total.teamId) ?? []), total]);
  }
  const recounts: {
    total: (typeof totals)[number];
    score: number;
    first: number;
  }[] = [];
  for (const rows of byTeam.values()) {
    rows.sort((a, b) => a.eventSequence - b.eventSequence);
    let running = 0;
    const history: { sequence: number; running: number }[] = [];
    for (const total of rows) {
      running += total.points;
      history.push({ sequence: total.eventSequence, running });
      const first = history.find((h) => h.running >= running)!.sequence;
      recounts.push({ total, score: running, first });
    }
  }
  const atEvent = new Map<string, typeof recounts>();
  for (const entry of recounts) {
    const { eventId } = entry.total;
    atEvent.set(eventId, [...(atEvent.get(eventId) ?? []), entry]);
  }
  for (const [eventId, entries] of atEvent) {
    const event = eventOf.get(eventId);
    const rank = ranks(entries);
    for (const entry of entries) {
      const { total, score, first } = entry;
      const at = `round ${event?.round} team ${total.teamId}`;
      if (total.cumulativePoints !== score) {
        found.push(
          `${at}: running total ${total.cumulativePoints}, recount ${score}`,
        );
      }
      if (total.firstReachedSequence !== first) {
        found.push(
          `${at}: first reached ${total.firstReachedSequence}, recount ${first}`,
        );
      }
      if (total.globalRank !== rank.get(entry)) {
        found.push(
          `${at}: rank ${total.globalRank}, recount ${rank.get(entry)}`,
        );
      }
      if (total.eventSequence !== event?.sequence) {
        found.push(
          `${at}: sequence ${total.eventSequence}, the game event's is ${event?.sequence}`,
        );
      }
      const status = event?.status === "final" ? "final" : "provisional";
      if (total.status !== status) {
        found.push(`${at}: status ${total.status}, recount ${status}`);
      }
    }
  }

  // --- League tables ------------------------------------------------------
  const tableLeagues = await db
    .select()
    .from(leagues)
    .where(
      and(
        eq(leagues.gameId, gameId),
        eq(leagues.status, "active"),
        ne(leagues.kind, "global"),
      ),
    );
  const activeTeams = new Set(
    (
      await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.gameId, gameId), eq(teams.status, "active")))
    ).map((team) => team.id),
  );
  for (const league of tableLeagues) {
    const members = (
      await db
        .select({
          teamId: leagueMemberships.teamId,
          leftAt: leagueMemberships.leftAt,
        })
        .from(leagueMemberships)
        .where(eq(leagueMemberships.leagueId, league.id))
    ).filter((m) => m.leftAt === null && activeTeams.has(m.teamId));
    const table = await db
      .select()
      .from(leagueStandings)
      .where(eq(leagueStandings.leagueId, league.id));

    const entries = members.flatMap(({ teamId }) => {
      const rows = (byTeam.get(teamId) ?? []).filter(
        (t) =>
          t.eventSequence >= league.startSequence &&
          (league.endSequence === null ||
            t.eventSequence <= league.endSequence),
      );
      if (rows.length === 0) return [];
      let running = 0;
      const history = rows.map((t) => {
        running += t.points;
        return { sequence: t.eventSequence, running };
      });
      const score = running;
      const first = history.find((h) => h.running >= score)!.sequence;
      return [{ teamId, score, first, through: rows.at(-1)!.eventSequence }];
    });
    const rank = ranks(entries);
    const through = Math.max(...entries.map((e) => e.through));
    const throughEvent = calendar.find((e) => e.sequence === through);
    const roundOf = (eventId: string) => eventOf.get(eventId)?.round;
    for (const entry of entries) {
      const at = `league ${league.name} team ${entry.teamId}`;
      const row = table.find((r) => r.teamId === entry.teamId);
      if (!row) {
        found.push(`${at}: no row in the table`);
        continue;
      }
      if (row.points !== entry.score) {
        found.push(`${at}: points ${row.points}, recount ${entry.score}`);
      }
      if (row.firstReachedSequence !== entry.first) {
        found.push(
          `${at}: first reached ${row.firstReachedSequence}, recount ${entry.first}`,
        );
      }
      if (row.rank !== rank.get(entry)) {
        found.push(`${at}: rank ${row.rank}, recount ${rank.get(entry)}`);
      }
      if (row.throughEventId !== throughEvent?.eventId) {
        found.push(
          `${at}: through round ${roundOf(row.throughEventId)}, recount round ${throughEvent?.round}`,
        );
      }
      const status = throughEvent?.status === "final" ? "final" : "provisional";
      if (row.status !== status) {
        found.push(`${at}: status ${row.status}, recount ${status}`);
      }
    }
    for (const row of table) {
      if (!entries.some((e) => e.teamId === row.teamId)) {
        found.push(
          `league ${league.name} team ${row.teamId}: a row for a team not in the table`,
        );
      }
    }
  }

  // --- Constructors -------------------------------------------------------
  const pool = await db
    .select({
      id: poolAssets.id,
      assetType: poolAssets.assetType,
      driverId: poolAssets.driverId,
      constructorId: poolAssets.constructorId,
      from: poolAssets.addedFromEventId,
    })
    .from(poolAssets)
    .where(eq(poolAssets.gameId, gameId));
  const driverAsset = new Map(
    pool.filter((a) => a.driverId).map((a) => [a.driverId!, a]),
  );
  const constructorAssets = pool.filter((a) => a.constructorId);
  const rulesOf = new Map<string, ScoringRule[]>();
  for (const event of calendar) {
    if (rulesOf.has(event.rulesetVersionId)) continue;
    rulesOf.set(
      event.rulesetVersionId,
      (
        await db
          .select({
            code: scoringRules.code,
            sessionKind: scoringRules.sessionKind,
            target: scoringRules.target,
            kind: scoringRules.kind,
            category: scoringRules.category,
            params: scoringRules.params,
            sortOrder: scoringRules.sortOrder,
          })
          .from(scoringRules)
          .where(eq(scoringRules.rulesetVersionId, event.rulesetVersionId))
      ).map((rule) => scoringRuleSchema.parse(rule)),
    );
  }
  const rowsOf = new Map<string, Result[]>();
  if (scored.length > 0) {
    for (const row of await db
      .select()
      .from(effectiveResults)
      .where(
        inArray(
          effectiveResults.sessionId,
          scored.map((s) => s.id),
        ),
      )) {
      rowsOf.set(row.sessionId, [...(rowsOf.get(row.sessionId) ?? []), row]);
    }
  }

  for (const session of scored) {
    const event = eventOf.get(session.eventId);
    if (!event) continue;
    const at = `round ${event.round} ${session.kind}`;
    const rules = (rulesOf.get(event.rulesetVersionId) ?? []).filter(
      (r) => r.sessionKind === session.kind,
    );
    const ruleOf = new Map(rules.map((r) => [r.code, r]));
    const driverRules = rules.filter(
      (r): r is DriverRule => r.target === "driver",
    );
    const rows = rowsOf.get(session.id) ?? [];
    const inPool = (driverId: string) => {
      const asset = driverAsset.get(driverId);
      const added = asset && eventOf.get(asset.from)?.sequence;
      return added !== undefined && added !== null && event.sequence !== null
        ? added <= event.sequence
          ? asset
          : undefined
        : undefined;
    };

    for (const constructor of constructorAssets) {
      const own = linesAt.get(`${session.id}/${constructor.id}`) ?? [];
      const name = `constructor ${constructor.constructorId}`;
      const drivers = rows.filter(
        (r) => r.constructorId === constructor.constructorId,
      );

      for (const line of own) {
        const rule = ruleOf.get(line.ruleCode);
        const subject = line.subjectDriverId;
        if (rule?.kind === "knockout_stage") {
          if (subject !== null) {
            found.push(`${at}: ${name} ${line.ruleCode} names a driver`);
          }
          continue;
        }
        if (subject === null) {
          found.push(`${at}: ${name} ${line.ruleCode} has no driver`);
          continue;
        }
        const driver = drivers.find((d) => d.driverId === subject);
        if (!driver) {
          found.push(
            `${at}: ${name} a line from ${subject}, who has no result for it`,
          );
        } else if (
          rule?.kind === "per_driver_penalty" &&
          !rule.params.classifications.includes(driver.classification)
        ) {
          found.push(
            `${at}: ${name} ${line.ruleCode} for ${subject}, who isn't listed`,
          );
        }
      }

      for (const driver of drivers) {
        const subject = driver.driverId;
        const mine = own.filter((l) => l.subjectDriverId === subject);
        const asset = inPool(subject);
        const expected = new Map<string, number>();
        if (asset) {
          for (const line of linesAt.get(`${session.id}/${asset.id}`) ?? []) {
            expected.set(line.ruleCode, line.points);
          }
        } else {
          for (const rule of driverRules) {
            const points = recountDriverRule(rule, driver, rows.length);
            if (points !== null) expected.set(rule.code, points);
          }
        }
        const source = asset ? "the driver has" : "not in the pool, recount";
        for (const [code, points] of expected) {
          const line = mine.find((l) => l.ruleCode === code);
          if (!line) {
            found.push(
              `${at}: ${name} has no ${code} for ${subject}, ${source} ${points}`,
            );
          } else if (line.points !== points) {
            found.push(
              `${at}: ${name} has ${code} for ${subject} at ${line.points}, ${source} ${points}`,
            );
          }
        }
        for (const line of mine) {
          if (
            ruleOf.get(line.ruleCode)?.target === "driver" &&
            !expected.has(line.ruleCode)
          ) {
            found.push(
              `${at}: ${name} has ${line.ruleCode} for ${subject} at ${line.points}, ${source} none`,
            );
          }
        }
        for (const rule of rules) {
          if (
            rule.kind === "per_driver_penalty" &&
            rule.params.classifications.includes(driver.classification) &&
            !mine.some((l) => l.ruleCode === rule.code)
          ) {
            found.push(
              `${at}: ${name} has no ${rule.code} for ${subject}, expected ${rule.params.points}`,
            );
          }
        }
      }
    }
  }
  return found;
}

/** What a re-score could change, without the ids a run stamps on its rows. */
async function ledgerRows(db: Db, gameId: string) {
  const lines = await db
    .select({
      sessionId: assetScoreLines.sessionId,
      assetId: assetScoreLines.assetId,
      ruleCode: assetScoreLines.ruleCode,
      category: assetScoreLines.category,
      subjectDriverId: assetScoreLines.subjectDriverId,
      points: assetScoreLines.points,
      detail: assetScoreLines.detail,
    })
    .from(assetScoreLines)
    .where(eq(assetScoreLines.gameId, gameId));
  const adjustments = await db
    .select({
      teamId: teamAdjustmentLines.teamId,
      eventId: teamAdjustmentLines.eventId,
      sessionId: teamAdjustmentLines.sessionId,
      assetId: teamAdjustmentLines.assetId,
      lineType: teamAdjustmentLines.lineType,
      category: teamAdjustmentLines.category,
      points: teamAdjustmentLines.points,
    })
    .from(teamAdjustmentLines)
    .where(eq(teamAdjustmentLines.gameId, gameId));
  const totals = await db
    .select({
      teamId: teamEventTotals.teamId,
      eventId: teamEventTotals.eventId,
      points: teamEventTotals.points,
      pointsBySession: teamEventTotals.pointsBySession,
      cumulativePoints: teamEventTotals.cumulativePoints,
      firstReachedSequence: teamEventTotals.firstReachedSequence,
      globalRank: teamEventTotals.globalRank,
      status: teamEventTotals.status,
    })
    .from(teamEventTotals)
    .where(eq(teamEventTotals.gameId, gameId));
  const standings = await db
    .select({
      leagueId: leagueStandings.leagueId,
      teamId: leagueStandings.teamId,
      points: leagueStandings.points,
      firstReachedSequence: leagueStandings.firstReachedSequence,
      rank: leagueStandings.rank,
      previousRank: leagueStandings.previousRank,
      throughEventId: leagueStandings.throughEventId,
      status: leagueStandings.status,
    })
    .from(leagueStandings)
    .innerJoin(leagues, eq(leagues.id, leagueStandings.leagueId))
    .where(eq(leagues.gameId, gameId));
  return {
    asset_score_lines: canonical(lines),
    team_adjustment_lines: canonical(adjustments),
    team_event_totals: canonical(totals),
    league_standings: canonical(standings),
  };
}

class RollBackRescore extends Error {}

/**
 * Re-scores every session the game scores with `force`, rebuilds totals and
 * standings, compares the ledger before and after, and rolls it all back, so
 * the game is left as it was. Returns one message per table that changed, and
 * one if it couldn't reach every session with a current run: a re-score that
 * ran nothing would otherwise find nothing changed.
 */
async function checkForcedRescore(
  db: Db,
  gameId: string,
  now: Date,
): Promise<string[]> {
  const found: string[] = [];
  await db
    .transaction(async (tx) => {
      const before = await ledgerRows(tx, gameId);
      const sessionsToScore = await scoredSessions(tx, gameId);
      const [current] = await tx
        .select({ n: count() })
        .from(scoringRuns)
        .where(
          and(eq(scoringRuns.gameId, gameId), eq(scoringRuns.isCurrent, true)),
        );
      if (sessionsToScore.length !== current!.n) {
        found.push(
          `a forced re-score reached ${sessionsToScore.length} of the ${current!.n} sessions with a current run`,
        );
      }
      for (const { sessionId } of sessionsToScore) {
        const started = await startRun(tx, now, {
          gameId,
          sessionId,
          trigger: "replay",
          mode: "live",
          force: true,
        });
        if (!("runId" in started)) continue;
        const { runId } = started;
        await writeAssetLines(tx, now, runId);
        let afterTeamId: string | null = null;
        for (;;) {
          const batch: Awaited<ReturnType<typeof writeTeamAdjustments>> =
            await writeTeamAdjustments(tx, now, runId, { afterTeamId });
          if (batch === "superseded") {
            throw new Error(`forced re-score: run ${runId} was superseded`);
          }
          if (batch.done) break;
          afterTeamId = batch.lastTeamId;
        }
        await finishRun(tx, now, runId);
      }
      const eventIds = [...new Set(sessionsToScore.map((s) => s.eventId))];
      for (const eventId of eventIds) {
        await recomputeTotals(tx, now, { gameId, fromEventId: eventId });
        await recomputeStandings(tx, now, { gameId, eventId });
      }
      const after = await ledgerRows(tx, gameId);
      for (const table of Object.keys(before) as (keyof typeof before)[]) {
        const was = new Set(before[table]);
        const is = new Set(after[table]);
        const changed =
          before[table].filter((row) => !is.has(row)).length +
          after[table].filter((row) => !was.has(row)).length;
        if (changed > 0) {
          found.push(
            `a forced re-score changes ${table}: ${changed} rows differ`,
          );
        }
      }
      throw new RollBackRescore();
    })
    .catch((error: unknown) => {
      if (!(error instanceof RollBackRescore)) throw error;
    });
  return found;
}

/**
 * `checkScoringLedger`, then a forced re-score of every session, which must
 * change nothing and leaves nothing behind. `now` stamps the re-score's rows
 * in the transaction it rolls back. Slow on a full season: run it once, at the
 * end.
 */
export async function checkScoringInvariants(
  db: Db,
  gameId: string,
  options: { now: Date },
): Promise<string[]> {
  return [
    ...(await checkScoringLedger(db, gameId)),
    ...(await checkForcedRescore(db, gameId, options.now)),
  ];
}
