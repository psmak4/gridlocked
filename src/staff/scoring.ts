/**
 * The scoring board (M8 Task 8, wave 5's dry run board): the game's latest
 * dry run, added up into four tiles and the biggest changes, with **Discard**
 * and **Approve and re-score**; **Start a dry run** when there is none; and
 * the game's ruleset versions, read-only. Ruleset corrections are
 * `pnpm staff correct-ruleset` until the editor (decision 3). Nothing here
 * changes points: a dry run writes no lines, and an approval queues the
 * live re-score (`approveRescore`).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  events,
  gameEvents,
  games,
  leagueMemberships,
  leagues,
  leagueStandings,
  rulesetVersions as rulesetVersionsTable,
  scoringRuns,
  sessions,
  teamEventStates,
  teamEventTotals,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { approveRescore, discardDryRun, dryRunGame } from "@/game/corrections";
import { GameError } from "@/game/errors";
import { isStaffErrorCode, StaffError } from "./errors";
import type { StaffActor } from "./roster";

export type DryRunTile = { label: string; value: string; sub: string };

export type DryRunRow = {
  teamId: string;
  team: string;
  events: string;
  /** The season's points now, and after the re-score. */
  before: number;
  after: number;
  change: number;
};

export type DryRunSummary = {
  /** The `game.dry_run` audit row: what an approval names. */
  dryRunId: string;
  /** `running` while its runs are still scoring; `approved` once approved. */
  state: "running" | "pending" | "approved";
  reason: string | null;
  startedAt: Date;
  engineVersion: string;
  tiles: DryRunTile[];
  rows: DryRunRow[];
  /** The events whose points change, in order. */
  events: { id: string; round: number; name: string }[];
  /** How many scored sessions an approval re-scores. */
  sessions: number;
};

/** The biggest-changes table's length. */
const ROWS = 10;

/** "−12" or "+5", with a real minus sign. */
export function signed(n: number): string {
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/** "Round 6", or "Rounds 6, 11 and 18" (`and: false`: "Rounds 6, 11, 18"). */
export function roundsWords(rounds: number[], and = true): string {
  if (rounds.length === 1) return `Round ${rounds[0]}`;
  if (!and || rounds.length === 0) return `Rounds ${rounds.join(", ")}`;
  return `Rounds ${rounds.slice(0, -1).join(", ")} and ${rounds.at(-1)}`;
}

const auditAfter = (after: unknown) =>
  (after ?? {}) as { engineVersion?: string; runIds?: string[] };

/**
 * The game's latest dry run, added up, or null when there is none, or the
 * latest was discarded, replaced or failed. Its runs' `diff_summary.teams`
 * give each team's change per session; a team's season before is the sum of
 * its stored event totals. A league's first place changes when the teams
 * level on top after the re-score aren't the ones ranked first now, counting
 * only the events in the league's range.
 */
export async function dryRunSummary(
  db: Db,
  gameId: string,
): Promise<DryRunSummary | null> {
  const [latest] = await db
    .select({
      id: auditLog.id,
      reason: auditLog.reason,
      after: auditLog.after,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "game.dry_run"),
        eq(auditLog.entityType, "game"),
        eq(auditLog.entityId, gameId),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  if (!latest) return null;
  const { engineVersion = "", runIds = [] } = auditAfter(latest.after);
  const runs =
    runIds.length === 0
      ? []
      : await db
          .select({
            id: scoringRuns.id,
            status: scoringRuns.status,
            diff: scoringRuns.diffSummary,
            eventId: sessions.eventId,
          })
          .from(scoringRuns)
          .innerJoin(sessions, eq(sessions.id, scoringRuns.sessionId))
          .where(inArray(scoringRuns.id, runIds));
  if (runs.some((r) => r.status === "failed" || r.status === "superseded")) {
    return null;
  }
  const [approved] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "game.rescore_approved"),
        eq(auditLog.entityId, gameId),
        sql`${auditLog.after} ->> 'dryRunId' = ${latest.id}`,
      ),
    )
    .limit(1);
  const state = runs.some((r) => r.status === "running")
    ? "running"
    : approved
      ? "approved"
      : "pending";

  // Each team's change, by event.
  const byTeam = new Map<string, Map<string, number>>();
  const changedEvents = new Set<string>();
  for (const run of runs) {
    const diff = (run.diff ?? {}) as {
      teams?: { id: string; change: number }[];
      assetsChanged?: number;
    };
    if ((diff.assetsChanged ?? 0) > 0) changedEvents.add(run.eventId);
    for (const { id, change } of diff.teams ?? []) {
      if (change === 0) continue;
      changedEvents.add(run.eventId);
      const perEvent = byTeam.get(id) ?? new Map<string, number>();
      perEvent.set(run.eventId, (perEvent.get(run.eventId) ?? 0) + change);
      byTeam.set(id, perEvent);
    }
  }
  const total = (perEvent: Map<string, number>) =>
    [...perEvent.values()].reduce((a, b) => a + b, 0);

  const eventRows =
    changedEvents.size === 0
      ? []
      : await db
          .select({
            id: events.id,
            round: events.round,
            name: events.name,
            sequence: gameEvents.sequence,
          })
          .from(events)
          .innerJoin(
            gameEvents,
            and(
              eq(gameEvents.eventId, events.id),
              eq(gameEvents.gameId, gameId),
            ),
          )
          .where(inArray(events.id, [...changedEvents]))
          .orderBy(asc(events.round));
  const roundOf = new Map(eventRows.map((e) => [e.id, e.round]));
  const sequenceOf = new Map(eventRows.map((e) => [e.id, e.sequence ?? 0]));

  const [{ count: lockedTeams } = { count: 0 }] = await db
    .select({
      count: sql<number>`count(distinct ${teamEventStates.teamId})::int`,
    })
    .from(teamEventStates)
    .where(eq(teamEventStates.gameId, gameId));

  const changedIds = [...byTeam.keys()];
  const names = new Map<string, string>();
  const seasonNow = new Map<string, number>();
  if (changedIds.length > 0) {
    for (const row of await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(inArray(teams.id, changedIds))) {
      names.set(row.id, row.name);
    }
    for (const row of await db
      .select({
        teamId: teamEventTotals.teamId,
        points: sql<number>`coalesce(sum(${teamEventTotals.points}), 0)::int`,
      })
      .from(teamEventTotals)
      .where(inArray(teamEventTotals.teamId, changedIds))
      .groupBy(teamEventTotals.teamId)) {
      seasonNow.set(row.teamId, row.points);
    }
  }

  const rows: DryRunRow[] = changedIds
    .map((teamId) => {
      const perEvent = byTeam.get(teamId)!;
      const before = seasonNow.get(teamId) ?? 0;
      const change = total(perEvent);
      const rounds = [...perEvent.keys()]
        .map((id) => roundOf.get(id))
        .filter((r): r is number => r !== undefined)
        .sort((a, b) => a - b);
      return {
        teamId,
        team: names.get(teamId) ?? "",
        events: roundsWords(rounds, false),
        before,
        after: before + change,
        change,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.change) - Math.abs(a.change) ||
        a.team.localeCompare(b.team) ||
        a.teamId.localeCompare(b.teamId),
    );

  const leaders = await leadersChanged(db, gameId, byTeam, sequenceOf);
  const biggest = rows[0];
  const rounds = eventRows.map((e) => e.round);

  return {
    dryRunId: latest.id,
    state,
    reason: latest.reason,
    startedAt: latest.createdAt,
    engineVersion,
    tiles: [
      {
        label: "TEAMS AFFECTED",
        value: String(rows.length),
        sub: `of ${lockedTeams.toLocaleString("en-GB")}`,
      },
      {
        label: "EVENTS",
        value: String(eventRows.length),
        sub: rounds.length > 0 ? roundsWords(rounds) : "No points change",
      },
      {
        label: "BIGGEST CHANGE",
        value: biggest ? signed(biggest.change) : "0",
        sub: biggest ? biggest.team : "No team changes",
      },
      {
        label: "LEAGUE LEADERS",
        value: String(leaders),
        sub: "Leagues whose 1st place changes",
      },
    ],
    rows: rows.slice(0, ROWS),
    events: eventRows.map((e) => ({ id: e.id, round: e.round, name: e.name })),
    sessions: runs.length,
  };
}

/** How many of the game's leagues would have a different first place. */
async function leadersChanged(
  db: Db,
  gameId: string,
  byTeam: Map<string, Map<string, number>>,
  sequenceOf: Map<string, number>,
): Promise<number> {
  if (byTeam.size === 0) return 0;
  const touched = await db
    .selectDistinct({
      id: leagues.id,
      start: leagues.startSequence,
      end: leagues.endSequence,
    })
    .from(leagues)
    .innerJoin(leagueMemberships, eq(leagueMemberships.leagueId, leagues.id))
    .where(
      and(
        eq(leagues.gameId, gameId),
        inArray(leagueMemberships.teamId, [...byTeam.keys()]),
      ),
    );
  let changed = 0;
  for (const league of touched) {
    const standings = await db
      .select({
        teamId: leagueStandings.teamId,
        points: leagueStandings.points,
        rank: leagueStandings.rank,
      })
      .from(leagueStandings)
      .where(eq(leagueStandings.leagueId, league.id));
    if (standings.length === 0) continue;
    const inRange = (eventId: string) => {
      const seq = sequenceOf.get(eventId);
      return (
        seq !== undefined &&
        seq >= league.start &&
        (league.end === null || seq <= league.end)
      );
    };
    const after = standings.map((s) => {
      let delta = 0;
      for (const [eventId, change] of byTeam.get(s.teamId) ?? []) {
        if (inRange(eventId)) delta += change;
      }
      return { teamId: s.teamId, points: s.points + delta };
    });
    const top = Math.max(...after.map((s) => s.points));
    const leadersAfter = new Set(
      after.filter((s) => s.points === top).map((s) => s.teamId),
    );
    const leadersNow = new Set(
      standings.filter((s) => s.rank === 1).map((s) => s.teamId),
    );
    const same =
      leadersAfter.size === leadersNow.size &&
      [...leadersNow].every((id) => leadersAfter.has(id));
    if (!same) changed += 1;
  }
  return changed;
}

export type RulesetVersionRow = {
  id: string;
  version: number;
  isCorrection: boolean;
  notes: string;
  publishedAt: Date;
  /** The round it's effective from. */
  fromRound: number | null;
  /** The rounds whose game event uses it now. */
  rounds: number[];
};

/** The game's ruleset versions, newest first, read-only. */
export async function rulesetVersions(
  db: Db,
  gameId: string,
): Promise<RulesetVersionRow[]> {
  const versions = await db
    .select({
      id: rulesetVersionsTable.id,
      version: rulesetVersionsTable.version,
      isCorrection: rulesetVersionsTable.isCorrection,
      notes: rulesetVersionsTable.notes,
      publishedAt: rulesetVersionsTable.publishedAt,
      fromRound: events.round,
    })
    .from(rulesetVersionsTable)
    .leftJoin(events, eq(events.id, rulesetVersionsTable.effectiveFromEventId))
    .where(eq(rulesetVersionsTable.gameId, gameId))
    .orderBy(desc(rulesetVersionsTable.version));
  const uses = await db
    .select({
      versionId: gameEvents.rulesetVersionId,
      round: events.round,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(events.round));
  return versions.map((v) => ({
    ...v,
    rounds: uses.filter((u) => u.versionId === v.id).map((u) => u.round),
  }));
}

/** The game the scoring board is for: the running one, else the newest. */
export async function scoringGame(
  db: Db,
): Promise<{ id: string; name: string; status: string } | null> {
  const [game] = await db
    .select({ id: games.id, name: games.name, status: games.status })
    .from(games)
    .orderBy(
      sql`case when ${games.status} = 'running' then 0 else 1 end`,
      desc(games.id),
    )
    .limit(1);
  return game ?? null;
}

/** A game-layer refusal as the staff screen's code, when it has one. */
async function asStaff<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GameError && isStaffErrorCode(error.code)) {
      throw new StaffError(error.code, error.message);
    }
    throw error;
  }
}

/** **Start a dry run**: what a re-score of the whole game would change. */
export function startDryRun(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { gameId: string; reason: string },
) {
  return asStaff(() => dryRunGame(db, now, actor, input));
}

/** **Approve and re-score**, naming the dry run the screen showed. */
export function approveDryRun(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { gameId: string; dryRunId: string; reason: string },
) {
  return asStaff(() => approveRescore(db, now, actor, input));
}

/** **Discard**: the dry run is set aside, and nothing is re-scored. */
export function discardGameDryRun(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { gameId: string; reason: string },
) {
  return asStaff(() => discardDryRun(db, now, actor, input));
}
