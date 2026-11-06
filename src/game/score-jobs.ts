import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import {
  events,
  gameEvents,
  games,
  type SCORING_RUN_TRIGGERS,
  scoringRuns,
  sessionResultState,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import {
  gameFinalizeKey,
  gameFinalizePayload,
  gameOpenFinalKey,
  scoreKey,
  scoreSessionPayload,
  scoreStepKey,
  type GameFinalizePayload,
  type GameOpenPayload,
  type ScoreSessionPayload,
} from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { recomputeStandings } from "@/leagues/standings";
import { openReviewItem } from "@/reference/review";
import { SCORED_KINDS } from "@/results/validate";
import { isLockedOrLater, LOCKED_OR_LATER } from "./jobs";
import { runPriceUpdate } from "./price-formula";
import {
  failRun,
  finishRun,
  lockLedger,
  startRun,
  writeAssetLines,
  writeTeamAdjustments,
} from "./scoring-runs";
import { recomputeTotals } from "./totals";

// The scoring pipeline (DM 4.8): the jobs that run when results change. A
// session's results, override or exception queue `score_session`, which
// scores it in steps of one job each, and the event's +48 h finalize queues
// `game_finalize`, which closes the event for the game. They read results only
// through the scoring steps and never write results or reference data (DM 0.5).

type Trigger = (typeof SCORING_RUN_TRIGGERS)[number];

/** A session in one of these has results that can be scored. */
const SCORABLE_RESULTS = ["provisional", "final"] as const;
const hasScorableResults = (status: string | null | undefined) =>
  (SCORABLE_RESULTS as readonly (string | null | undefined)[]).includes(status);

/** A game event in one of these can become `final`. */
const FINALIZABLE: ("locked" | "scored")[] = ["locked", "scored"];
const isFinalizable = (status: string) =>
  (FINALIZABLE as readonly string[]).includes(status);

/**
 * The sessions `enqueueScoring` accepts for a game (with `eventIds`, only of
 * those events), by event sequence and then in session order: the game is
 * `running`, its game event `locked`, `scored` or `final`, and the session is
 * one the engine scores, not cancelled, with `provisional` or `final` results.
 */
export async function scoredSessions(
  db: Db,
  gameId: string,
  eventIds?: string[],
): Promise<{ sessionId: string; eventId: string }[]> {
  return db
    .select({ sessionId: sessions.id, eventId: sessions.eventId })
    .from(sessions)
    .innerJoin(
      sessionResultState,
      eq(sessionResultState.sessionId, sessions.id),
    )
    .innerJoin(
      gameEvents,
      and(
        eq(gameEvents.eventId, sessions.eventId),
        eq(gameEvents.gameId, gameId),
      ),
    )
    .innerJoin(games, eq(games.id, gameEvents.gameId))
    .where(
      and(
        eq(games.status, "running"),
        inArray(gameEvents.status, [...LOCKED_OR_LATER]),
        ne(sessions.status, "cancelled"),
        inArray(sessions.kind, [...SCORED_KINDS]),
        inArray(sessionResultState.status, [...SCORABLE_RESULTS]),
        eventIds === undefined
          ? undefined
          : inArray(sessions.eventId, eventIds),
      ),
    )
    .orderBy(
      asc(gameEvents.sequence),
      asc(sessions.scheduledStart),
      asc(sessions.id),
    );
}

/**
 * Queues scoring of a session, one job per `running` game whose game event for
 * the session's event is `locked`, `scored` or `final` (or only for `gameId`,
 * given an exception, which belongs to one game), and returns how many it
 * queued. A session that is cancelled, that the engine doesn't score or whose
 * result status isn't `provisional` or `final` queues nothing, so a session
 * under review waits: resolving it moves no status, and the next `finalize_check`
 * or revalidate does, which calls this again.
 *
 * `stamp` is `v<resultsVersion>` from the results hooks, `x:<auditId>` from an
 * exception change, `c:<auditId>` from a correction version and `r:<auditId>`
 * from an approved re-score. It is in the job's key, so calling this again for
 * the same change queues nothing. Call it with the transaction of the change
 * when there is one. `force` runs the session even with the current run's
 * inputs.
 */
export async function enqueueScoring(
  db: Db,
  now: Date,
  input: {
    sessionId: string;
    stamp: string;
    trigger: Trigger;
    gameId?: string;
    force?: boolean;
  },
): Promise<number> {
  const { sessionId, stamp, trigger, gameId, force } = input;
  const [session] = await db
    .select({
      kind: sessions.kind,
      status: sessions.status,
      eventId: sessions.eventId,
      resultStatus: sessionResultState.status,
    })
    .from(sessions)
    .leftJoin(sessionResultState, eq(sessionResultState.sessionId, sessions.id))
    .where(eq(sessions.id, sessionId));
  if (
    !session ||
    session.status === "cancelled" ||
    !SCORED_KINDS.includes(session.kind) ||
    !hasScorableResults(session.resultStatus)
  ) {
    return 0;
  }

  const running = await db
    .select({ gameId: gameEvents.gameId })
    .from(gameEvents)
    .innerJoin(games, eq(games.id, gameEvents.gameId))
    .where(
      and(
        eq(gameEvents.eventId, session.eventId),
        eq(games.status, "running"),
        inArray(gameEvents.status, [...LOCKED_OR_LATER]),
        gameId === undefined ? undefined : eq(gameEvents.gameId, gameId),
      ),
    )
    .orderBy(asc(gameEvents.gameId));
  let queued = 0;
  for (const game of running) {
    const payload: ScoreSessionPayload = {
      gameId: game.gameId,
      sessionId,
      trigger,
      step: "assets",
      force,
    };
    const { created } = await enqueue(db, {
      kind: "score_session",
      dedupeKey: scoreKey(game.gameId, sessionId, stamp),
      runAt: now,
      payload,
    });
    if (created) queued += 1;
  }
  return queued;
}

/**
 * Queues `game_finalize` for each `running` game whose game event for
 * `eventId` is `locked` or `scored`. Called in the transaction that makes the
 * event `completed`.
 */
export async function enqueueGameFinalize(
  db: Db,
  now: Date,
  eventId: string,
): Promise<void> {
  const playing = await db
    .select({ gameId: gameEvents.gameId })
    .from(gameEvents)
    .innerJoin(games, eq(games.id, gameEvents.gameId))
    .where(
      and(
        eq(gameEvents.eventId, eventId),
        eq(games.status, "running"),
        inArray(gameEvents.status, FINALIZABLE),
      ),
    )
    .orderBy(asc(gameEvents.gameId));
  for (const { gameId } of playing) {
    const payload: GameFinalizePayload = { gameId, eventId };
    await enqueue(db, {
      kind: "game_finalize",
      dedupeKey: gameFinalizeKey(gameId, eventId),
      runAt: now,
      payload,
    });
  }
}

/** Runs a started run's steps through to its finish, in this call. */
async function runInline(
  db: Db,
  now: Date,
  runId: string,
  batchSize: number | undefined,
): Promise<void> {
  if ((await writeAssetLines(db, now, runId)) === "superseded") return;
  let afterTeamId: string | null = null;
  for (;;) {
    const batch: Awaited<ReturnType<typeof writeTeamAdjustments>> =
      await writeTeamAdjustments(db, now, runId, { afterTeamId, batchSize });
    if (batch === "superseded") return;
    if (batch.done) break;
    afterTeamId = batch.lastTeamId;
  }
  await finishRun(db, now, runId);
}

/**
 * Closes an event for a game, once its results are final (DM 4.8), or once it
 * was cancelled after its lock (DM 3.9). A dead job, and a cancelled event,
 * which has no job, are picked up by `planGameJobs`' daily sweep. Returns quietly unless the game event is `locked` or `scored`: `final` is a retry of
 * one that committed, `cancelled` has no totals, and `upcoming` or `open`
 * means the game never played this event.
 *
 * First, outside any transaction since runs are batched, each scored session
 * of the event with results (`provisional` or `final`; not cancelled) is
 * re-run inline unless its current run matches its fingerprint (`startRun`
 * skips then). A session with no results has no run: one would write
 * absent-driver penalties. A run superseded here belongs to the newer run's
 * chain, so it just stops.
 *
 * Then, in one transaction, the ledger lock first (the standings step's order,
 * ledger then `game_events` row, so the two can't deadlock). The status is read
 * again under that lock, holding the row, and unless it is still `locked` or
 * `scored` the transaction commits nothing: a handler past its lease can run
 * twice, and a cancel can land after the first look.
 * - `runPriceUpdate` prices the next event as the game event still stands. With
 *   nothing scored it skips (`no_scores`), and the open job carries the prices;
 * - the game event becomes `final`;
 * - totals and standings are rebuilt, in that order: both take their `final`
 *   status from the game event, which is why they follow it;
 * - a `next_open` skip opens the warning `prices_carried`: the next window
 *   opened first, so it runs on carried prices;
 * - if the next game event is `upcoming`, `game_open` is queued for it, due
 *   now, under its own key.
 */
export async function finalizeGameEvent(
  db: Db,
  now: Date,
  input: { gameId: string; eventId: string; batchSize?: number },
): Promise<void> {
  const { gameId, eventId, batchSize } = input;
  const thisGameEvent = and(
    eq(gameEvents.gameId, gameId),
    eq(gameEvents.eventId, eventId),
  );
  const [row] = await db
    .select({
      status: gameEvents.status,
      sequence: gameEvents.sequence,
      seasonId: events.seasonId,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(thisGameEvent);
  if (!row || !isFinalizable(row.status)) return;
  const { sequence, seasonId } = row;
  if (sequence === null) {
    throw new Error(`finalizeGameEvent: event ${eventId} has no sequence`);
  }

  const scored = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(
      sessionResultState,
      eq(sessionResultState.sessionId, sessions.id),
    )
    .where(
      and(
        eq(sessions.eventId, eventId),
        ne(sessions.status, "cancelled"),
        inArray(sessions.kind, [...SCORED_KINDS]),
        inArray(sessionResultState.status, [...SCORABLE_RESULTS]),
      ),
    )
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
  for (const { id: sessionId } of scored) {
    const started = await startRun(db, now, {
      gameId,
      sessionId,
      trigger: "results",
      mode: "live",
    });
    if ("runId" in started) {
      await runInline(db, now, started.runId, batchSize);
    }
  }

  await db.transaction(async (tx) => {
    await lockLedger(tx, { gameId, eventId });
    // Looked at again: a second pass, or a cancel, may have landed since.
    const [current] = await tx
      .select({ status: gameEvents.status })
      .from(gameEvents)
      .where(thisGameEvent)
      .for("update");
    if (!current || !isFinalizable(current.status)) return;
    const update = await runPriceUpdate(tx, now, {
      gameId,
      afterEventId: eventId,
      ranBy: "system",
    });
    await tx
      .update(gameEvents)
      .set({ status: "final", updatedAt: now })
      .where(and(thisGameEvent, inArray(gameEvents.status, FINALIZABLE)));
    await recomputeTotals(tx, now, { gameId, fromEventId: eventId });
    await recomputeStandings(tx, now, { gameId, eventId });
    if ("skipped" in update && update.skipped === "next_open") {
      await openReviewItem(tx, now, {
        kind: "prices_carried",
        severity: "warning",
        seasonId,
        eventId,
        details: { gameId },
        dedupeKey: `prices_carried:${gameId}:${eventId}`,
      });
    }
    const [next] = await tx
      .select({ eventId: gameEvents.eventId, status: gameEvents.status })
      .from(gameEvents)
      .where(
        and(eq(gameEvents.gameId, gameId), gt(gameEvents.sequence, sequence)),
      )
      .orderBy(asc(gameEvents.sequence))
      .limit(1);
    if (next?.status === "upcoming") {
      const payload: GameOpenPayload = { gameId, eventId: next.eventId };
      await enqueue(tx, {
        kind: "game_open",
        dedupeKey: gameOpenFinalKey(gameId, next.eventId),
        runAt: now,
        payload,
      });
    }
  });
}

/**
 * The session's event and where it stands for the game, or null when it has
 * no game event that has locked (a cancelled one included): a job that finds
 * that has nothing to do.
 */
async function scoringContext(db: Db, gameId: string, sessionId: string) {
  const [row] = await db
    .select({
      eventId: sessions.eventId,
      sessionStatus: sessions.status,
      resultStatus: sessionResultState.status,
      gameEventStatus: gameEvents.status,
    })
    .from(sessions)
    .innerJoin(
      gameEvents,
      and(
        eq(gameEvents.eventId, sessions.eventId),
        eq(gameEvents.gameId, gameId),
      ),
    )
    .leftJoin(sessionResultState, eq(sessionResultState.sessionId, sessions.id))
    .where(eq(sessions.id, sessionId));
  return row && isLockedOrLater(row.gameEventStatus) ? row : null;
}

/** True while the run can still go on: a retry may find it finished. */
async function isRunning(db: Db, runId: string): Promise<boolean> {
  const [run] = await db
    .select({ status: scoringRuns.status })
    .from(scoringRuns)
    .where(eq(scoringRuns.id, runId));
  return run?.status === "running";
}

/**
 * The handlers for `score_session` and `game_finalize`. `batchSize` is the
 * number of teams a `teams` job writes (`writeTeamAdjustments`' default, about
 * 1,000, when absent).
 *
 * `score_session` runs one step of a run, and the next step is a job of its
 * own, keyed by the run:
 * - **`assets`** starts the run (a skip, the same inputs as the current run,
 *   ends the chain with nothing else run, unless the job is forced) and writes
 *   the asset lines.
 * - **`teams`** writes one batch, then queues the next batch or `standings`.
 *   Totals wait for `standings`: the ledger lock doesn't span a run, so they
 *   are only right after the last batch.
 * - **`standings`** rebuilds the totals from the event, then the standings,
 *   then in one transaction finishes the run and moves a `locked` game event to
 *   `scored`. A superseded run doesn't move it.
 *
 * Any step stops quietly when the game event is cancelled or hasn't locked.
 * `assets` also stops for a session that is cancelled or no longer has
 * results to score, and `teams` and `standings` for a run that isn't `running`
 * (a job run again after its run went on, or was superseded). Every step can
 * run twice: a second `assets` starts a new run, which supersedes the first.
 *
 * A step that throws is retried by the queue. On its last attempt its run, if
 * it has one by then, is marked `failed` first.
 *
 * `game_finalize` runs `finalizeGameEvent`.
 */
export function createScoreHandlers(
  options: { batchSize?: number } = {},
): Record<"score_session" | "game_finalize", JobHandler> {
  const { batchSize } = options;

  const score: JobHandler = async (job, ctx) => {
    const db = ctx.db as Db;
    const payload = scoreSessionPayload.parse(job.payload);
    const { gameId, sessionId, trigger, step } = payload;
    const now = ctx.clock.now();
    let runId = payload.runId;

    const queueStep = (
      next: "teams" | "standings",
      run: string,
      afterTeamId?: string,
    ) => {
      const nextPayload: ScoreSessionPayload = {
        gameId,
        sessionId,
        trigger,
        runId: run,
        step: next,
        afterTeamId,
      };
      return enqueue(db, {
        kind: "score_session",
        dedupeKey: scoreStepKey(run, next, afterTeamId),
        runAt: now,
        payload: nextPayload,
      });
    };

    try {
      const context = await scoringContext(db, gameId, sessionId);
      if (!context) return;

      if (step === "assets") {
        if (
          context.sessionStatus === "cancelled" ||
          !hasScorableResults(context.resultStatus)
        ) {
          return;
        }
        const started = await startRun(db, now, {
          gameId,
          sessionId,
          trigger,
          mode: "live",
          force: payload.force,
        });
        if (!("runId" in started)) return;
        runId = started.runId;
        if ((await writeAssetLines(db, now, runId)) === "superseded") return;
        await queueStep("teams", runId);
        return;
      }

      if (runId === undefined) {
        throw new Error(`score_session: a ${step} job has no run`);
      }
      if (!(await isRunning(db, runId))) return;

      if (step === "teams") {
        const batch = await writeTeamAdjustments(db, now, runId, {
          afterTeamId: payload.afterTeamId ?? null,
          batchSize,
        });
        if (batch === "superseded") return;
        if (batch.done) {
          await queueStep("standings", runId);
        } else {
          if (batch.lastTeamId === null) {
            throw new Error(
              `score_session: run ${runId} is not done and has no last team`,
            );
          }
          await queueStep("teams", runId, batch.lastTeamId);
        }
        return;
      }

      const { eventId } = context;
      await recomputeTotals(db, now, { gameId, fromEventId: eventId });
      await recomputeStandings(db, now, { gameId, eventId });
      const finishing = runId;
      await db.transaction(async (tx) => {
        if ((await finishRun(tx, now, finishing)) === "superseded") return;
        await tx
          .update(gameEvents)
          .set({ status: "scored", updatedAt: now })
          .where(
            and(
              eq(gameEvents.gameId, gameId),
              eq(gameEvents.eventId, eventId),
              eq(gameEvents.status, "locked"),
            ),
          );
      });
    } catch (error) {
      if (runId !== undefined && job.attempts >= job.maxAttempts) {
        await failRun(db, now, runId);
      }
      throw error;
    }
  };

  const finalize: JobHandler = async (job, ctx) => {
    await finalizeGameEvent(ctx.db as Db, ctx.clock.now(), {
      ...gameFinalizePayload.parse(job.payload),
      batchSize,
    });
  };

  return { score_session: score, game_finalize: finalize };
}
