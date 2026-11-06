import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/audit/log";
import { gameEvents, games, rulesetVersions, scoringRuns } from "@/db/schema";
import type { Db } from "@/db/types";
import { gameChecksPayload } from "@/jobs/kinds";
import type { JobHandler } from "@/jobs/runner";
import { recomputeStandings } from "@/leagues/standings";
import { openReviewItem } from "@/reference/review";
import { ENGINE_VERSION } from "@/scoring/engine";
import { scoringRuleSchema, type ScoringRule } from "@/scoring/rules";
import { audit, requireReason, type StaffActor } from "@/staff/roster";
import { GameError } from "./errors";
import { insertRulesetVersion } from "./games";
import { rulesetParamsSchema, type RulesetParams } from "./ruleset";
import { enqueueScoring, scoredSessions } from "./score-jobs";
import {
  biggestOf,
  dryRunEvent,
  failRun,
  startRun,
  type Change,
} from "./scoring-runs";
import { recomputeTotals } from "./totals";

// Corrections (DM 4.9) and the daily checks (DM 4.8, 3.7). The staff actions
// change scores after the fact, each audited with a reason, and always through
// the scoring pipeline: a correction version re-points past events and re-scores
// them, a dry run reports what a re-score would change without writing it, and
// approving queues that re-score. The daily job checks that stored totals can
// be explained and prunes old lineup versions. Reads results only through the
// scoring steps, and never writes results or reference data (DM 0.5).

/** The game event statuses a correction can re-point. */
const CORRECTABLE = ["locked", "scored", "final"];
/** How long after an event goes `final` its unused versions stay (DM 3.7). */
const PRUNE_AFTER_MS = 7 * 24 * 3_600_000;

/**
 * Publishes a correction version and re-points past events to it (DM 4.9), in
 * one transaction: a new version with `is_correction` set, numbered after the
 * game's latest and effective from the first listed event by sequence, with
 * `rules` stored under it; each listed game event moved to it; the audit row;
 * and a re-score of every scored session of those events (`enqueueScoring`,
 * trigger `ruleset_correction`, stamp `c:<auditId>`).
 *
 * Only the listed events move: later ones stay on their version, and planning
 * never gives them this one. Lock records keep the version they locked under.
 * Points change and prices don't (DM 3.5), since nothing here or in the re-score
 * runs the price formula.
 *
 * `gridlocked.ruleset_correction` is what lets the re-point past the trigger of
 * `game_rules_10`. It is set for this transaction only and turned off again
 * straight after the update, so it covers that one statement even when a
 * caller's transaction goes on.
 *
 * Refuses, writing nothing: a blank reason, params or rules their schemas
 * refuse, no rules (the re-score would wipe the events' points), an empty list,
 * a game that isn't `running` (`game_not_running`: nothing would re-score it),
 * and an event that isn't `locked`, `scored` or `final` in the game. The game
 * row is held, so a version number can't be taken twice and planning waits its
 * turn.
 */
export async function publishCorrectionVersion(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: {
    gameId: string;
    params: RulesetParams;
    rules: ScoringRule[];
    notes: string;
    eventIds: string[];
    reason: string;
  },
): Promise<{ rulesetVersionId: string }> {
  const { gameId, notes } = input;
  const meta = audit(actor, requireReason(input.reason));
  const params = rulesetParamsSchema.parse(input.params);
  const rules = input.rules.map((rule) => scoringRuleSchema.parse(rule));
  if (rules.length === 0) {
    throw new Error(`publishCorrectionVersion: no rules for game ${gameId}`);
  }
  const eventIds = [...new Set(input.eventIds)];
  if (eventIds.length === 0) {
    throw new Error(`publishCorrectionVersion: no events for game ${gameId}`);
  }

  return db.transaction(async (tx) => {
    const [game] = await tx
      .select({ status: games.status })
      .from(games)
      .where(eq(games.id, gameId))
      .for("update");
    if (!game) throw new Error(`publishCorrectionVersion: no game ${gameId}`);
    if (game.status !== "running") {
      throw new GameError(
        "game_not_running",
        `game ${gameId} is ${game.status}, so a correction would re-score nothing`,
      );
    }

    const listed = await tx
      .select({
        eventId: gameEvents.eventId,
        status: gameEvents.status,
        rulesetVersionId: gameEvents.rulesetVersionId,
      })
      .from(gameEvents)
      .where(
        and(
          eq(gameEvents.gameId, gameId),
          inArray(gameEvents.eventId, eventIds),
        ),
      )
      .orderBy(asc(gameEvents.sequence))
      .for("update");
    const found = new Set(listed.map((row) => row.eventId));
    const missing = eventIds.find((id) => !found.has(id));
    if (missing !== undefined) {
      throw new Error(
        `publishCorrectionVersion: event ${missing} is not in game ${gameId}`,
      );
    }
    const refused = listed.find((row) => !CORRECTABLE.includes(row.status));
    if (refused) {
      throw new Error(
        `publishCorrectionVersion: event ${refused.eventId} is ${refused.status}, and only an event that has locked is corrected`,
      );
    }

    const [latest] = await tx
      .select({ version: max(rulesetVersions.version) })
      .from(rulesetVersions)
      .where(eq(rulesetVersions.gameId, gameId));
    const version = (latest?.version ?? 0) + 1;
    const rulesetVersionId = await insertRulesetVersion(tx, now, {
      gameId,
      version,
      effectiveFromEventId: listed[0]!.eventId,
      isCorrection: true,
      params,
      rules,
      notes,
    });

    await tx.execute(
      sql`select set_config('gridlocked.ruleset_correction', 'on', true)`,
    );
    await tx
      .update(gameEvents)
      .set({ rulesetVersionId, updatedAt: now })
      .where(
        and(
          eq(gameEvents.gameId, gameId),
          inArray(gameEvents.eventId, eventIds),
        ),
      );
    await tx.execute(
      sql`select set_config('gridlocked.ruleset_correction', 'off', true)`,
    );

    const auditId = await writeAudit(tx, now, {
      ...meta,
      action: "ruleset_version.correct",
      entityType: "ruleset_version",
      entityId: rulesetVersionId,
      before: {
        gameId,
        events: listed.map(({ eventId, rulesetVersionId: from }) => ({
          eventId,
          rulesetVersionId: from,
        })),
      },
      after: { gameId, version, eventIds: listed.map((row) => row.eventId) },
    });
    for (const { sessionId } of await scoredSessions(tx, gameId, eventIds)) {
      await enqueueScoring(tx, now, {
        sessionId,
        stamp: `c:${auditId}`,
        trigger: "ruleset_correction",
        gameId,
      });
    }
    return { rulesetVersionId };
  });
}

/**
 * What a re-score of the whole game would change, with the current engine and
 * rules (DM 4.9). In one transaction it starts a `dry_run` run for every scored
 * session (`scoredSessions`) and audits; the scoring is batched, outside it, an
 * event at a time (`dryRunEvent`). It compares against the current lines and
 * the stored totals, and writes one `dry_run` run per session with its
 * `diff_summary`: no lines, no adjustment lines and no totals. A dry run never
 * supersedes a live run, nor a live run a dry one.
 *
 * Returns the runs, the number of sessions, how many different assets and teams
 * would change anywhere, and the biggest changes. A change is one session's, so
 * a team can be there twice.
 *
 * A second dry run started meanwhile takes over: this one throws. Whatever
 * throws marks its runs that are still `running` as `failed`.
 */
export async function dryRunGame(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { gameId: string; reason: string; batchSize?: number },
): Promise<{
  runIds: string[];
  sessions: number;
  assetsChanged: number;
  teamsChanged: number;
  biggest: Change[];
}> {
  const { gameId, batchSize } = input;
  const meta = audit(actor, requireReason(input.reason));

  const byEvent = new Map<string, { runId: string; sessionId: string }[]>();
  const runIds = await db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const { sessionId, eventId } of await scoredSessions(tx, gameId)) {
      const started = await startRun(tx, now, {
        gameId,
        sessionId,
        trigger: "admin",
        mode: "dry_run",
      });
      if (!("runId" in started)) {
        throw new Error(`dryRunGame: a dry run of ${sessionId} was skipped`);
      }
      ids.push(started.runId);
      const runs = byEvent.get(eventId) ?? [];
      runs.push({ runId: started.runId, sessionId });
      byEvent.set(eventId, runs);
    }
    await writeAudit(tx, now, {
      ...meta,
      action: "game.dry_run",
      entityType: "game",
      entityId: gameId,
      before: null,
      after: { engineVersion: ENGINE_VERSION, runIds: ids },
    });
    return ids;
  });

  const assets = new Set<string>();
  const teams = new Set<string>();
  let biggest: Change[] = [];
  try {
    for (const [eventId, runs] of byEvent) {
      const report = await dryRunEvent(db, now, {
        gameId,
        eventId,
        runs,
        batchSize,
      });
      if (report === "superseded") {
        throw new Error(`dryRunGame: a newer dry run of ${gameId} took over`);
      }
      for (const id of report.assets) assets.add(id);
      for (const id of report.teams) teams.add(id);
      biggest = biggestOf([...biggest, ...report.biggest]);
    }
  } catch (error) {
    for (const runId of runIds) await failRun(db, now, runId);
    throw error;
  }
  return {
    runIds,
    sessions: runIds.length,
    assetsChanged: assets.size,
    teamsChanged: teams.size,
    biggest,
  };
}

/**
 * Queues the live re-score an admin approved after a dry run (DM 4.9): every
 * scored session (`enqueueScoring`, trigger `engine_change`, stamp
 * `r:<auditId>`), forced, so it runs even where the inputs haven't changed.
 * Audited in the same transaction, and returns how many jobs it queued.
 *
 * Refuses, writing nothing: a blank reason, and a game with no `dry_run` run
 * that succeeded at the current `ENGINE_VERSION` (`dry_run_required`).
 */
export async function approveRescore(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { gameId: string; reason: string },
): Promise<{ queued: number }> {
  const { gameId } = input;
  const meta = audit(actor, requireReason(input.reason));
  return db.transaction(async (tx) => {
    const [dryRun] = await tx
      .select({ id: scoringRuns.id })
      .from(scoringRuns)
      .where(
        and(
          eq(scoringRuns.gameId, gameId),
          eq(scoringRuns.mode, "dry_run"),
          eq(scoringRuns.engineVersion, ENGINE_VERSION),
          eq(scoringRuns.status, "succeeded"),
        ),
      )
      .limit(1);
    if (!dryRun) {
      throw new GameError(
        "dry_run_required",
        `run a dry run of game ${gameId} on engine ${ENGINE_VERSION} first`,
      );
    }
    const auditId = await writeAudit(tx, now, {
      ...meta,
      action: "game.rescore_approved",
      entityType: "game",
      entityId: gameId,
      before: null,
      after: { engineVersion: ENGINE_VERSION },
    });
    let queued = 0;
    for (const { sessionId } of await scoredSessions(tx, gameId)) {
      queued += await enqueueScoring(tx, now, {
        sessionId,
        stamp: `r:${auditId}`,
        trigger: "engine_change",
        gameId,
        force: true,
      });
    }
    return { queued };
  });
}

const mismatchSchema = z.object({
  team_id: z.string(),
  event_id: z.string(),
  season_id: z.string(),
  stored: z.number(),
  explained: z.number(),
});

/**
 * The daily check that scores can be explained (DM 4.8): for a random `sample`
 * of the game's teams with a lock record, each event's `team_base_lines` plus
 * `team_adjustment_lines` must equal its stored `team_event_totals.points`
 * (0 with no row, so a lost row shows).
 *
 * Events that are `locked`, `scored` or `final` are compared, and not one with a
 * live run `running`: totals disagree with the lines mid-run by design, and the
 * run's own totals step puts them right. One statement reads the runs and the
 * ledger, so they are of one moment.
 *
 * Each event found wrong, earliest first, in one transaction of its own (as
 * `recomputeTotals` asks) opens the blocking review item `score_mismatch`, and
 * rebuilds that event's totals from the ledger, then its standings. Every wrong
 * event is rebuilt, not only the earliest: `recomputeTotals` rewrites later
 * events' running totals but not their points. While the item is open it holds
 * an unfinished event's finalization. Its key, `score_mismatch:<game>:<event>`,
 * is unique only while open, so a new mismatch opens a new item after an
 * admin resolves the old one.
 *
 * Returns how many team-events disagreed and which events were rebuilt.
 *
 * `base` and `adjustments` are materialized so each runs once: inlined, a
 * nested loop reads the whole aggregate again for every lock record.
 */
export async function checkScoreExplanations(
  db: Db,
  now: Date,
  input: { gameId: string; sample?: number },
): Promise<{ mismatches: number; events: string[] }> {
  const { gameId, sample = 200 } = input;
  if (!Number.isInteger(sample) || sample < 1) {
    throw new RangeError(
      `checkScoreExplanations: sample ${sample} is not a positive integer`,
    );
  }
  const game = sql`${gameId}::uuid`;
  const { rows } = (await db.execute(sql`
    with sampled as (
      select team_id
      from (select distinct team_id from team_event_states where game_id = ${game}) t
      order by random()
      limit ${sample}
    ), base as materialized (
      select b.team_id, b.event_id, sum(b.points)::integer as points
      from team_base_lines b
      join sampled x on x.team_id = b.team_id
      where b.game_id = ${game}
      group by b.team_id, b.event_id
    ), adjustments as materialized (
      select a.team_id, a.event_id, sum(a.points)::integer as points
      from team_adjustment_lines a
      join sampled x on x.team_id = a.team_id
      where a.game_id = ${game}
      group by a.team_id, a.event_id
    )
    select s.team_id, s.event_id, e.season_id,
           coalesce(t.points, 0) as stored,
           coalesce(b.points, 0) + coalesce(a.points, 0) as explained
    from team_event_states s
    join sampled x on x.team_id = s.team_id
    join game_events g on g.game_id = s.game_id and g.event_id = s.event_id
    join events e on e.id = s.event_id
    left join team_event_totals t on t.team_id = s.team_id and t.event_id = s.event_id
    left join base b on b.team_id = s.team_id and b.event_id = s.event_id
    left join adjustments a on a.team_id = s.team_id and a.event_id = s.event_id
    where s.game_id = ${game}
      and g.status in ('locked', 'scored', 'final')
      and coalesce(t.points, 0) <> coalesce(b.points, 0) + coalesce(a.points, 0)
      and not exists (
        select 1
        from scoring_runs r
        join sessions se on se.id = r.session_id
        where r.game_id = ${game} and se.event_id = s.event_id
          and r.mode = 'live' and r.status = 'running'
      )
    order by g.sequence, s.team_id
  `)) as { rows: unknown[] };
  const found = rows.map((row) => mismatchSchema.parse(row));

  const eventIds = [...new Set(found.map((row) => row.event_id))];
  for (const eventId of eventIds) {
    const wrong = found.filter((row) => row.event_id === eventId);
    await db.transaction(async (tx) => {
      await openReviewItem(tx, now, {
        kind: "score_mismatch",
        severity: "blocking",
        seasonId: wrong[0]!.season_id,
        eventId,
        details: {
          gameId,
          teams: wrong.map(({ team_id, stored, explained }) => ({
            teamId: team_id,
            stored,
            explained,
          })),
        },
        dedupeKey: `score_mismatch:${gameId}:${eventId}`,
      });
      await recomputeTotals(tx, now, { gameId, fromEventId: eventId });
      await recomputeStandings(tx, now, { gameId, eventId });
    });
  }
  return { mismatches: found.length, events: eventIds };
}

const prunedSchema = z.object({ deleted: z.number() });

/**
 * Deletes the lineup versions no one needs any more (DM 3.7), and returns how
 * many. A version goes when its event has been `final` for 7 days or more, by
 * the game event's `updated_at` (a later update, such as a correction, only
 * delays it), unless:
 * - a lock record points to it, as its base, its locked lineup or its Late Call,
 *   whichever event that record is for;
 * - it is the team's newest for the event, by `(saved_at, id)`: the last one
 *   before lock, for a team with no lock record, and what `saveLineup` reads as
 *   the team's latest.
 *
 * A kept version based on a deleted one has its `based_on_version_id` nulled.
 * One statement; run again, it deletes nothing.
 */
export async function pruneLineupVersions(
  db: Db,
  now: Date,
  input: { gameId: string },
): Promise<{ deleted: number }> {
  const game = sql`${input.gameId}::uuid`;
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS).toISOString();
  const { rows } = (await db.execute(sql`
    with used as (
      select base_version_id as id from team_event_states
      where game_id = ${game} and base_version_id is not null
      union
      select locked_version_id from team_event_states where game_id = ${game}
      union
      select final_fix_version_id from team_event_states
      where game_id = ${game} and final_fix_version_id is not null
    ), gone as (
      delete from lineup_versions v
      using teams t, game_events g
      where t.id = v.team_id and t.game_id = ${game}
        and g.game_id = ${game} and g.event_id = v.for_event_id
        and g.status = 'final' and g.updated_at <= ${cutoff}::timestamptz
        and v.id not in (select id from used)
        and exists (
          select 1 from lineup_versions newer
          where newer.team_id = v.team_id
            and newer.for_event_id = v.for_event_id
            and (newer.saved_at, newer.id) > (v.saved_at, v.id)
        )
      returning v.id
    )
    select count(*)::integer as deleted from gone
  `)) as { rows: unknown[] };
  return prunedSchema.parse(rows[0]);
}

/**
 * The `game_checks` handler (DM 4.8), queued daily by `sync_calendar` for each
 * `running` game: `checkScoreExplanations`, then `pruneLineupVersions`. Both can
 * run twice. One that throws is retried by the queue, on its own.
 */
export function createGameChecksHandler(): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const { gameId } = gameChecksPayload.parse(job.payload);
    const now = ctx.clock.now();
    await checkScoreExplanations(db, now, { gameId });
    await pruneLineupVersions(db, now, { gameId });
  };
}
