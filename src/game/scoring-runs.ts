import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  assetScoreLines,
  assetSessionTotals,
  effectiveResults,
  gameEvents,
  gameSessionExceptions,
  lineupPicks,
  lineupVersions,
  poolAssets,
  type SCORING_RUN_MODES,
  type SCORING_RUN_TRIGGERS,
  rulesetVersions,
  scoringRules,
  scoringRuns,
  sessions,
  teamAdjustmentLines,
  teamEventStates,
  teamEventTotals,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import {
  ENGINE_VERSION,
  scoreSession,
  type AssetLine,
  type PoolEntry,
  type SessionInput,
} from "@/scoring/engine";
import { scoringRuleSchema, type ScoringRule } from "@/scoring/rules";
import {
  effectiveLineup,
  teamAdjustments,
  type AdjustmentLine,
  type AssetSessionPoints,
  type TeamEventInput,
  type TeamPick,
} from "./adjustments";
import { playedChips } from "./chips";
import { priceList } from "./prices";
import { rulesetParamsSchema } from "./ruleset";

// Scoring runs and the two-tier ledger (DM 4.1-4.3, 4.8 steps 1-2): a run
// scores one session of one game, in steps that are each one transaction so a
// job can run them one at a time: `startRun`, `writeAssetLines`,
// `writeTeamAdjustments` batch by batch, then `finishRun`. Each write step
// takes the event's ledger lock and checks its run is still the newest of its
// mode for the session; if not, it marks the run `superseded` and stops, so
// the later of two runs wins and their writes never interleave. Reads results
// only through `effective_results`, and never writes results or reference data
// (DM 0.5).

/** Teams per batch: about 1,000 per job (DM 4.8). */
const BATCH = 1000;
/** Rows per insert, well under Postgres's limit on bind parameters. */
const INSERT_CHUNK = 1000;
/** The engine's session kinds; practice never scores, nor in 2026 sprint qualifying. */
const SCORED_KINDS = ["qualifying", "sprint", "race"] as const;
/** A game event in one of these has its lock record, so it can be scored. */
const SCORABLE = ["locked", "scored", "final"] as const;
/** How many of the biggest changes a run's diff summary keeps. */
const BIGGEST = 10;

type Trigger = (typeof SCORING_RUN_TRIGGERS)[number];
type Mode = (typeof SCORING_RUN_MODES)[number];
type ScoredKind = (typeof SCORED_KINDS)[number];

/** What a run stores as `inputs`: what the explanation cites. */
interface RunInputs {
  /** The session's `effective_results` rows as read, by driver id. */
  results: (typeof effectiveResults.$inferSelect)[];
  exception: { policy: string; reason: string } | null;
}

/** An asset or team whose points changed against the previous current run. */
const changeSchema = z.object({
  kind: z.enum(["asset", "team"]),
  id: z.string(),
  before: z.number().int(),
  after: z.number().int(),
  change: z.number().int(),
});
export type Change = z.infer<typeof changeSchema>;

/**
 * A run's `diff_summary`. `assets` is every asset whose session points
 * changed. While the team step runs, `teamsThrough` is the last team counted,
 * so a batch run again isn't counted twice; `finishRun` drops it.
 */
const diffSchema = z.object({
  previousRunId: z.string().nullable(),
  assetsChanged: z.number().int(),
  teamsChanged: z.number().int(),
  biggest: z.array(changeSchema),
  assets: z.array(
    z.object({
      assetId: z.string(),
      before: z.number().int(),
      after: z.number().int(),
    }),
  ),
  teamsThrough: z.string().nullable().optional(),
});
type DiffSummary = z.infer<typeof diffSchema>;

/**
 * Starts a run for a session of a game, and returns its id. It reads the
 * inputs (the session's effective results and exception, the game event's
 * ruleset version with its rules and knockout, the pool at the event, and
 * `ENGINE_VERSION`) and fingerprints them (`inputFingerprint`). A `live` run
 * is skipped, writing nothing, when its fingerprint is the current run's, that
 * run has `succeeded`, and no newer live run is still `running` (one that may
 * yet write what it read); `force` (a re-score an admin asked for) never
 * skips. The check and the insert hold the event's ledger lock, so a
 * `writeAssetLines` in flight commits first and the check sees what it made
 * current. The new run is `running`; the newest started is the one with the
 * highest id. A new live run also marks every earlier `running` live run of the
 * session `superseded`, in the same transaction, so a retried first step
 * doesn't leave its first run `running` for ever; a chain still in flight sees
 * the newer run and stops, as it would have anyway.
 *
 * Throws for a session the engine doesn't score (only qualifying, sprint and
 * race do), and for one whose event the game hasn't locked.
 */
export async function startRun(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    sessionId: string;
    trigger: Trigger;
    mode: Mode;
    force?: boolean;
  },
): Promise<{ runId: string } | { skipped: true }> {
  const { gameId, sessionId, trigger, mode } = input;
  return db.transaction(async (tx) => {
    const session = await loadSession(tx, gameId, sessionId);
    await lockLedger(tx, { gameId, eventId: session.eventId });
    const read = await readInputs(
      tx,
      gameId,
      session,
      session.rulesetVersionId,
    );
    if (mode === "live" && !input.force) {
      const current = await currentRun(tx, gameId, sessionId);
      if (
        current?.inputFingerprint === read.fingerprint &&
        current.status === "succeeded" &&
        !(await isSuperseded(tx, { ...current, gameId, sessionId, mode }, [
          "running",
        ]))
      ) {
        return { skipped: true };
      }
    }
    const runId = newId();
    await tx.insert(scoringRuns).values({
      id: runId,
      gameId,
      sessionId,
      rulesetVersionId: session.rulesetVersionId,
      engineVersion: ENGINE_VERSION,
      inputFingerprint: read.fingerprint,
      trigger,
      mode,
      status: "running",
      startedAt: now,
    });
    if (mode === "live") {
      await tx
        .update(scoringRuns)
        .set({ status: "superseded", finishedAt: now })
        .where(
          and(
            eq(scoringRuns.gameId, gameId),
            eq(scoringRuns.sessionId, sessionId),
            eq(scoringRuns.mode, "live"),
            eq(scoringRuns.status, "running"),
            lt(scoringRuns.id, runId),
          ),
        );
    }
    return { runId };
  });
}

/**
 * Step 1 (DM 4.8): scores the session and replaces its asset lines, in one
 * transaction. A newer run means `superseded`. Otherwise it reads the inputs
 * again (as scored, they are the run's `inputs` and fingerprint), deletes the
 * session's lines and inserts the new set (none for a `skip` exception), and
 * makes the run current. The diff summary's assets part is computed here,
 * against the lines it replaces. A dry run writes its inputs and diff but no
 * lines, and never becomes current. Run again after it has written, while
 * the run is still `running`, it returns `written` and changes nothing; once
 * the run has finished it throws.
 */
export async function writeAssetLines(
  db: Db,
  now: Date,
  runId: string,
): Promise<"written" | "superseded"> {
  return (await assetStep(db, now, runId)).status;
}

/** `writeAssetLines`, which also hands back the lines it scored, if it did. */
async function assetStep(
  db: Db,
  now: Date,
  runId: string,
): Promise<{ status: "written" | "superseded"; lines?: AssetLine[] }> {
  return db.transaction(async (tx) => {
    const run = await loadRun(tx, runId);
    await lockLedger(tx, run);
    if (await isSuperseded(tx, run)) {
      return { status: await supersede(tx, now, run.id) };
    }
    if (run.status !== "running") {
      throw new Error(`writeAssetLines: run ${runId} is ${run.status}`);
    }
    if (run.inputs !== null) return { status: "written" };

    const session = await loadSession(tx, run.gameId, run.sessionId);
    const read = await readInputs(
      tx,
      run.gameId,
      session,
      run.rulesetVersionId,
    );
    const lines =
      read.inputs.exception?.policy === "skip"
        ? []
        : scoreSession({
            sessionKind: session.kind,
            rules: read.rules,
            knockout: read.knockout,
            results: read.inputs.results,
            pool: read.pool,
          });

    const previous = await currentRun(tx, run.gameId, run.sessionId);
    const before = new Map(
      (
        await tx
          .select({
            assetId: assetSessionTotals.assetId,
            points: assetSessionTotals.points,
          })
          .from(assetSessionTotals)
          .where(
            and(
              eq(assetSessionTotals.gameId, run.gameId),
              eq(assetSessionTotals.sessionId, run.sessionId),
            ),
          )
      ).map((row) => [row.assetId, row.points]),
    );
    const after = assetTotals(lines);
    const assets = [...new Set([...before.keys(), ...after.keys()])]
      .sort(byText)
      .map((assetId) => ({
        assetId,
        before: before.get(assetId) ?? 0,
        after: after.get(assetId)?.total ?? 0,
      }))
      .filter((a) => a.before !== a.after);
    const diff: DiffSummary = {
      previousRunId: previous?.id ?? null,
      assetsChanged: assets.length,
      teamsChanged: 0,
      biggest: biggestOf(
        assets.map((a) => ({
          kind: "asset",
          id: a.assetId,
          before: a.before,
          after: a.after,
          change: a.after - a.before,
        })),
      ),
      assets,
      teamsThrough: null,
    };

    const done = {
      inputs: read.inputs,
      inputFingerprint: read.fingerprint,
      diffSummary: diff,
    };
    if (run.mode === "dry_run") {
      await tx.update(scoringRuns).set(done).where(eq(scoringRuns.id, run.id));
      return { status: "written", lines };
    }
    await tx
      .delete(assetScoreLines)
      .where(
        and(
          eq(assetScoreLines.gameId, run.gameId),
          eq(assetScoreLines.sessionId, run.sessionId),
        ),
      );
    for (const chunk of chunks(lines)) {
      await tx
        .insert(assetScoreLines)
        .values(chunk.map((line) => lineRow(run, line)));
    }
    // The old current run first: at most one is current (partial unique).
    if (previous) {
      await tx
        .update(scoringRuns)
        .set({ isCurrent: false })
        .where(eq(scoringRuns.id, previous.id));
    }
    await tx
      .update(scoringRuns)
      .set({ ...done, isCurrent: true })
      .where(eq(scoringRuns.id, run.id));
    return { status: "written", lines };
  });
}

/**
 * Step 2 (DM 4.8): one batch of the event's team adjustments, in one
 * transaction. The batch is up to `batchSize` teams with a lock record for the
 * event after `afterTeamId`, in id order; the next starts after `lastTeamId`,
 * and `done` says there are no more. Under the event's ledger lock, and
 * unless a newer run means `superseded`, it replaces each team's adjustment
 * lines for the whole event: `teamAdjustments` over every scored session of
 * the event (those with a current run), from the current asset totals, the
 * lock record (the locked and Late Call versions, the chip played and the
 * transfer penalty) and the event's prices, tagged with this run. Teams whose
 * event points changed are added to the diff summary. Run again, a batch
 * writes the same lines and counts nothing twice.
 *
 * Throws for a dry run (it writes no team lines) and for a run that hasn't
 * written its asset lines.
 */
export async function writeTeamAdjustments(
  db: Db,
  now: Date,
  runId: string,
  options: { afterTeamId?: string | null; batchSize?: number } = {},
): Promise<{ done: boolean; lastTeamId: string | null } | "superseded"> {
  const { afterTeamId = null, batchSize = BATCH } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      `writeTeamAdjustments: batchSize ${batchSize} is not a positive integer`,
    );
  }
  return db.transaction(async (tx) => {
    const run = await loadRun(tx, runId);
    await lockLedger(tx, run);
    if (await isSuperseded(tx, run)) return supersede(tx, now, run.id);
    if (run.mode !== "live") {
      throw new Error(
        `writeTeamAdjustments: run ${runId} is a dry run, which writes no team lines`,
      );
    }
    if (run.status !== "running" || !run.isCurrent) {
      throw new Error(
        `writeTeamAdjustments: run ${runId} is ${run.status} and hasn't written its asset lines`,
      );
    }
    const { gameId, eventId } = run;

    const states = await tx
      .select()
      .from(teamEventStates)
      .where(
        and(
          eq(teamEventStates.gameId, gameId),
          eq(teamEventStates.eventId, eventId),
          afterTeamId === null
            ? undefined
            : gt(teamEventStates.teamId, afterTeamId),
        ),
      )
      .orderBy(asc(teamEventStates.teamId))
      .limit(batchSize + 1);
    const more = states.length > batchSize;
    const batch = states.slice(0, batchSize);
    const teamIds = batch.map((s) => s.teamId);
    const lastTeamId = teamIds.at(-1) ?? null;
    if (batch.length === 0) return { done: !more, lastTeamId };

    const ledger = await eventLedger(tx, gameId, eventId);
    const inputs = await teamInputs(tx, ledger, eventId, batch);
    const oldPoints = new Map<string, number>();
    for (const line of await tx
      .select({
        teamId: teamAdjustmentLines.teamId,
        points: teamAdjustmentLines.points,
      })
      .from(teamAdjustmentLines)
      .where(
        and(
          eq(teamAdjustmentLines.eventId, eventId),
          inArray(teamAdjustmentLines.teamId, teamIds),
        ),
      )) {
      oldPoints.set(
        line.teamId,
        (oldPoints.get(line.teamId) ?? 0) + line.points,
      );
    }

    const diff = diffSchema.parse(run.diffSummary);
    const countedThrough = diff.teamsThrough ?? null;
    const assetChange = new Map(
      diff.assets.map((a) => [a.assetId, a.after - a.before]),
    );
    const rows: (typeof teamAdjustmentLines.$inferInsert)[] = [];
    const changes: Change[] = [];
    for (const state of batch) {
      const input = inputs.get(state.teamId)!;
      const lines = teamAdjustments(input);
      for (const line of lines) {
        rows.push({
          id: newId(),
          gameId,
          teamId: state.teamId,
          eventId,
          sessionId: line.sessionId,
          assetId: line.assetId,
          lineType: line.lineType,
          category: line.category,
          points: line.points,
          runId: run.id,
        });
      }

      // Before this run, the scored session's assets had their previous
      // totals and the team its previous lines.
      const adjusted = lines.reduce((sum, l) => sum + l.points, 0);
      const after = teamEventPoints(input, lines);
      const change =
        effectiveLineup(input, run.sessionId).reduce(
          (sum, pick) => sum + (assetChange.get(pick.assetId) ?? 0),
          0,
        ) +
        adjusted -
        (oldPoints.get(state.teamId) ?? 0);
      if (
        change !== 0 &&
        (countedThrough === null || state.teamId > countedThrough)
      ) {
        changes.push(teamChange(state.teamId, after - change, after));
      }
    }

    await tx
      .delete(teamAdjustmentLines)
      .where(
        and(
          eq(teamAdjustmentLines.eventId, eventId),
          inArray(teamAdjustmentLines.teamId, teamIds),
        ),
      );
    for (const chunk of chunks(rows)) {
      await tx.insert(teamAdjustmentLines).values(chunk);
    }
    const through =
      countedThrough !== null && countedThrough > lastTeamId!
        ? countedThrough
        : lastTeamId;
    await tx
      .update(scoringRuns)
      .set({
        diffSummary: {
          ...diff,
          teamsChanged: diff.teamsChanged + changes.length,
          biggest: biggestOf([...diff.biggest, ...changes]),
          teamsThrough: through,
        },
      })
      .where(eq(scoringRuns.id, run.id));
    return { done: !more, lastTeamId };
  });
}

/**
 * A dry run's scoring of one event (DM 4.9), for runs `startRun` began for its
 * sessions. Nothing here writes a line or a total: each run gets its inputs and
 * diff summary and finishes.
 *
 * Each session is scored as `writeAssetLines` scores it, and the lines are kept
 * in memory. Then every team with a lock record, in batches, is worked out
 * through the code a live run uses, once per session in order: the sessions
 * before it as re-scored and those after it as they stand, which is what a
 * re-score would have written by that session. A team's first `before` is its
 * stored `team_event_totals.points` (0 with no row), so a team changes where
 * the stored total disagrees, and each session's changes run on from the
 * last, adding up to the event's whole change. A run's `teamsChanged` and
 * `biggest` count what its session changes.
 *
 * Returns every asset and team that changed and the biggest changes, or
 * `superseded` if a newer dry run took over, which stops this one there.
 */
export async function dryRunEvent(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    eventId: string;
    runs: { runId: string; sessionId: string }[];
    batchSize?: number;
  },
): Promise<
  { assets: Set<string>; teams: Set<string>; biggest: Change[] } | "superseded"
> {
  const { gameId, eventId, runs, batchSize = BATCH } = input;
  const rescored = new Map<
    string,
    { runId: string; points: Map<string, AssetSessionPoints> }
  >();
  for (const { runId, sessionId } of runs) {
    const { status, lines } = await assetStep(db, now, runId);
    if (status === "superseded") return status;
    if (!lines) throw new Error(`dryRunEvent: run ${runId} has already scored`);
    rescored.set(sessionId, { runId, points: assetTotals(lines) });
  }

  const ledger = await eventLedger(db, gameId, eventId, [...rescored.keys()]);
  const seen = new Set(
    ledger.sessions.filter((s) => s.current).map((s) => s.sessionId),
  );
  const assetPoints = new Map(ledger.assetPoints);
  const steps = ledger.sessions.flatMap(({ sessionId }) => {
    const session = rescored.get(sessionId);
    if (!session) return [];
    seen.add(sessionId);
    assetPoints.set(sessionId, session.points);
    return {
      runId: session.runId,
      sessions: ledger.sessions.filter((s) => seen.has(s.sessionId)),
      assetPoints: new Map(assetPoints),
      teamsChanged: 0,
      biggest: [] as Change[],
    };
  });

  const teams = new Set<string>();
  let afterTeamId: string | null = null;
  for (;;) {
    const batch: (typeof teamEventStates.$inferSelect)[] = await db
      .select()
      .from(teamEventStates)
      .where(
        and(
          eq(teamEventStates.gameId, gameId),
          eq(teamEventStates.eventId, eventId),
          afterTeamId === null
            ? undefined
            : gt(teamEventStates.teamId, afterTeamId),
        ),
      )
      .orderBy(asc(teamEventStates.teamId))
      .limit(batchSize);
    if (batch.length === 0) break;
    const inputs = await teamInputs(db, ledger, eventId, batch);
    const stored = new Map(
      (
        await db
          .select({
            teamId: teamEventTotals.teamId,
            points: teamEventTotals.points,
          })
          .from(teamEventTotals)
          .where(
            and(
              eq(teamEventTotals.eventId, eventId),
              inArray(
                teamEventTotals.teamId,
                batch.map((s) => s.teamId),
              ),
            ),
          )
      ).map((row) => [row.teamId, row.points]),
    );
    for (const { teamId } of batch) {
      let before = stored.get(teamId) ?? 0;
      for (const step of steps) {
        const team = {
          ...inputs.get(teamId)!,
          sessions: step.sessions,
          assetPoints: step.assetPoints,
        };
        const after = teamEventPoints(team, teamAdjustments(team));
        if (after !== before) {
          teams.add(teamId);
          step.teamsChanged += 1;
          step.biggest = biggestOf([
            ...step.biggest,
            teamChange(teamId, before, after),
          ]);
        }
        before = after;
      }
    }
    afterTeamId = batch.at(-1)!.teamId;
  }

  const assets = new Set<string>();
  let biggest: Change[] = [];
  for (const step of steps) {
    const { diffSummary } = await loadRun(db, step.runId);
    const diff = diffSchema.parse(diffSummary);
    const merged = biggestOf([...diff.biggest, ...step.biggest]);
    await db
      .update(scoringRuns)
      .set({
        diffSummary: {
          ...diff,
          teamsChanged: step.teamsChanged,
          biggest: merged,
        },
      })
      .where(eq(scoringRuns.id, step.runId));
    if ((await finishRun(db, now, step.runId)) === "superseded") {
      return "superseded";
    }
    for (const { assetId } of diff.assets) assets.add(assetId);
    biggest = biggestOf([...biggest, ...merged]);
  }
  return { assets, teams, biggest };
}

/**
 * The last step: the run `succeeded`, with its `finished_at` and its diff
 * summary (`previousRunId`, `assetsChanged`, `teamsChanged`, the `BIGGEST`
 * biggest changes, and `assets`: every asset whose points changed). A newer
 * run means `superseded`. Run again, it returns `succeeded`.
 */
export async function finishRun(
  db: Db,
  now: Date,
  runId: string,
): Promise<"succeeded" | "superseded"> {
  return db.transaction(async (tx) => {
    const run = await loadRun(tx, runId);
    await lockLedger(tx, run);
    if (await isSuperseded(tx, run)) return supersede(tx, now, run.id);
    if (run.status === "succeeded") return "succeeded";
    if (run.status !== "running" || run.inputs === null) {
      throw new Error(
        `finishRun: run ${runId} is ${run.status} and hasn't written its asset lines`,
      );
    }
    const diff = diffSchema.parse(run.diffSummary);
    delete diff.teamsThrough;
    await tx
      .update(scoringRuns)
      .set({ status: "succeeded", finishedAt: now, diffSummary: diff })
      .where(eq(scoringRuns.id, run.id));
    return "succeeded";
  });
}

/**
 * Marks a run `failed`, with its `finished_at`, when the job running it has no
 * attempts left. Only a `running` run: one that went on or was superseded
 * keeps its status. Its lines stay until the next run replaces them, and a
 * failed current run is never skipped against, so that run always goes ahead.
 */
export async function failRun(db: Db, now: Date, runId: string): Promise<void> {
  await db
    .update(scoringRuns)
    .set({ status: "failed", finishedAt: now })
    .where(and(eq(scoringRuns.id, runId), eq(scoringRuns.status, "running")));
}

/** The session, with its game event's ruleset version and pool sequence. */
async function loadSession(db: Db, gameId: string, sessionId: string) {
  const [row] = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      eventId: sessions.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
      rulesetVersionId: gameEvents.rulesetVersionId,
    })
    .from(sessions)
    .innerJoin(
      gameEvents,
      and(
        eq(gameEvents.eventId, sessions.eventId),
        eq(gameEvents.gameId, gameId),
      ),
    )
    .where(eq(sessions.id, sessionId));
  if (!row) {
    throw new Error(
      `scoring: session ${sessionId} is not one of game ${gameId}`,
    );
  }
  const { kind, sequence, status } = row;
  if (!isScoredKind(kind)) {
    throw new Error(
      `scoring: session ${sessionId} is ${kind}, which never scores`,
    );
  }
  if (sequence === null || !(SCORABLE as readonly string[]).includes(status)) {
    throw new Error(
      `scoring: session ${sessionId}'s event is ${status} in game ${gameId}, not locked`,
    );
  }
  return { ...row, kind, sequence };
}

const isScoredKind = (kind: string): kind is ScoredKind =>
  (SCORED_KINDS as readonly string[]).includes(kind);

/** Everything a run reads, and its fingerprint (`inputFingerprint`). */
async function readInputs(
  db: Db,
  gameId: string,
  session: Awaited<ReturnType<typeof loadSession>>,
  rulesetVersionId: string,
) {
  const results = (
    await db
      .select()
      .from(effectiveResults)
      .where(eq(effectiveResults.sessionId, session.id))
  ).sort((a, b) => byText(a.driverId, b.driverId));
  const [exception] = await db
    .select({
      policy: gameSessionExceptions.policy,
      reason: gameSessionExceptions.reason,
    })
    .from(gameSessionExceptions)
    .where(
      and(
        eq(gameSessionExceptions.gameId, gameId),
        eq(gameSessionExceptions.sessionId, session.id),
      ),
    );
  const [version] = await db
    .select({ params: rulesetVersions.params })
    .from(rulesetVersions)
    .where(eq(rulesetVersions.id, rulesetVersionId));
  if (!version)
    throw new Error(`scoring: no ruleset version ${rulesetVersionId}`);
  const { knockout } = rulesetParamsSchema.parse(version.params);
  const rules = (
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
      .where(eq(scoringRules.rulesetVersionId, rulesetVersionId))
  )
    .map((rule) => scoringRuleSchema.parse(rule))
    .sort((a, b) => byText(a.code, b.code));
  // At the event: added from it or an earlier one (placed by sequence, as the
  // lineup check places it), withdrawn ones included, since their owners
  // keep them and their penalties (DM 3.4).
  const pool: PoolEntry[] = (
    await db
      .select({
        assetId: poolAssets.id,
        assetType: poolAssets.assetType,
        driverId: poolAssets.driverId,
        constructorId: poolAssets.constructorId,
      })
      .from(poolAssets)
      .where(
        and(
          eq(poolAssets.gameId, gameId),
          sql`game_event_sequence_from(${poolAssets.gameId}, ${poolAssets.addedFromEventId}) <= ${session.sequence}`,
        ),
      )
  ).sort((a, b) => byText(a.assetId, b.assetId));

  const inputs: RunInputs = { results, exception: exception ?? null };
  const fingerprint = inputFingerprint({
    rulesetVersionId,
    sessionKind: session.kind,
    knockout,
    rules,
    pool,
    inputs,
  });
  return { inputs, rules, knockout, pool, fingerprint };
}

/**
 * A run's `input_fingerprint`: SHA-256 of the canonical JSON of what it read
 * and `ENGINE_VERSION`. The results, rules and pool are sorted by driver id,
 * code and asset id, and every object's keys at every depth, so neither the
 * order rows come back in nor the order of their keys can change it. Every
 * column read is in it, so a change to one the engine ignores re-scores too,
 * with an empty diff.
 */
export function inputFingerprint(read: {
  rulesetVersionId: string;
  sessionKind: string;
  knockout: SessionInput["knockout"];
  rules: ScoringRule[];
  pool: PoolEntry[];
  inputs: RunInputs;
}): string {
  const { inputs } = read;
  return createHash("sha256")
    .update(
      canonicalJson({
        engineVersion: ENGINE_VERSION,
        ...read,
        rules: [...read.rules].sort((a, b) => byText(a.code, b.code)),
        pool: [...read.pool].sort((a, b) => byText(a.assetId, b.assetId)),
        inputs: {
          ...inputs,
          results: [...inputs.results].sort((a, b) =>
            byText(a.driverId, b.driverId),
          ),
        },
      }),
    )
    .digest("hex");
}

/** A Late Call version's race session, which a `final_fix` version must have. */
function lateCallFrom(
  fromSessions: Map<string, string | null>,
  versionId: string,
): string {
  const from = fromSessions.get(versionId);
  if (from === undefined || from === null) {
    throw new Error(
      `writeTeamAdjustments: Late Call version ${versionId} has no session it applies from`,
    );
  }
  return from;
}

/** JSON with every object's keys sorted, at every depth. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byText(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The run, with its session's event. */
async function loadRun(db: Db, runId: string) {
  const [run] = await db
    .select({ ...getTableColumns(scoringRuns), eventId: sessions.eventId })
    .from(scoringRuns)
    .innerJoin(sessions, eq(sessions.id, scoringRuns.sessionId))
    .where(eq(scoringRuns.id, runId));
  if (!run) throw new Error(`scoring: no run ${runId}`);
  return run;
}
type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

async function currentRun(db: Db, gameId: string, sessionId: string) {
  const [run] = await db
    .select({
      id: scoringRuns.id,
      inputFingerprint: scoringRuns.inputFingerprint,
      status: scoringRuns.status,
    })
    .from(scoringRuns)
    .where(
      and(
        eq(scoringRuns.gameId, gameId),
        eq(scoringRuns.sessionId, sessionId),
        eq(scoringRuns.isCurrent, true),
      ),
    );
  return run ?? null;
}

/**
 * The event's ledger lock, held to the end of the transaction: the asset
 * lines of its sessions and its team lines are written by one step at a time.
 * It is taken in each step's own transaction, so it keeps two steps (and a
 * `recomputeTotals`, which takes it too) from interleaving, but it is not held
 * across a run: totals rebuilt between a run's steps can see its new asset
 * lines next to the old team lines, and are right once the totals step (DM 4.8)
 * recomputes after the last team batch.
 */
export async function lockLedger(
  db: Db,
  run: { gameId: string; eventId: string },
) {
  const key = `ledger:${run.gameId}:${run.eventId}`;
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/**
 * True when a newer run of the same mode has started for the session (with
 * `statuses`, only one in those).
 */
async function isSuperseded(
  db: Db,
  run: Pick<LoadedRun, "id" | "gameId" | "sessionId" | "mode">,
  statuses?: LoadedRun["status"][],
): Promise<boolean> {
  const [newer] = await db
    .select({ id: scoringRuns.id })
    .from(scoringRuns)
    .where(
      and(
        eq(scoringRuns.gameId, run.gameId),
        eq(scoringRuns.sessionId, run.sessionId),
        eq(scoringRuns.mode, run.mode),
        gt(scoringRuns.id, run.id),
        statuses === undefined
          ? undefined
          : inArray(scoringRuns.status, statuses),
      ),
    )
    .limit(1);
  return newer !== undefined;
}

async function supersede(
  db: Db,
  now: Date,
  runId: string,
): Promise<"superseded"> {
  await db
    .update(scoringRuns)
    .set({ status: "superseded", finishedAt: now })
    .where(and(eq(scoringRuns.id, runId), eq(scoringRuns.status, "running")));
  return "superseded";
}

/**
 * What every team of the event shares: the event's scored sessions (those
 * with a current run, and any of `alsoSessionIds`, a dry run's: `current` says
 * which is which) in order, their asset totals, the pool's asset types and the
 * event's prices.
 */
async function eventLedger(
  db: Db,
  gameId: string,
  eventId: string,
  alsoSessionIds: string[] = [],
) {
  const scored = await db
    .select({
      sessionId: sessions.id,
      kind: sessions.kind,
      runId: scoringRuns.id,
    })
    .from(sessions)
    .leftJoin(
      scoringRuns,
      and(
        eq(scoringRuns.sessionId, sessions.id),
        eq(scoringRuns.gameId, gameId),
        eq(scoringRuns.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(sessions.eventId, eventId),
        or(
          isNotNull(scoringRuns.id),
          alsoSessionIds.length === 0
            ? undefined
            : inArray(sessions.id, alsoSessionIds),
        ),
      ),
    )
    // The order team_base_lines places a Late Call by.
    .orderBy(asc(sessions.scheduledStart), asc(sessions.id));
  const ordered = scored.map(({ sessionId, kind, runId }, order) => {
    if (!isScoredKind(kind)) {
      throw new Error(
        `scoring: session ${sessionId} is ${kind}, which never scores`,
      );
    }
    return { sessionId, kind, order, current: runId !== null };
  });

  const assetPoints = new Map<string, Map<string, AssetSessionPoints>>();
  if (ordered.length > 0) {
    for (const row of await db
      .select()
      .from(assetSessionTotals)
      .where(
        and(
          eq(assetSessionTotals.gameId, gameId),
          inArray(
            assetSessionTotals.sessionId,
            ordered.map((s) => s.sessionId),
          ),
        ),
      )) {
      const perAsset = assetPoints.get(row.sessionId) ?? new Map();
      perAsset.set(row.assetId, {
        total: row.points,
        byCategory: row.byCategory,
      });
      assetPoints.set(row.sessionId, perAsset);
    }
  }
  const assetTypes = new Map(
    (
      await db
        .select({ id: poolAssets.id, assetType: poolAssets.assetType })
        .from(poolAssets)
        .where(eq(poolAssets.gameId, gameId))
    ).map((a) => [a.id, a.assetType]),
  );
  const prices = await priceList(db, { gameId, eventId });
  return { sessions: ordered, assetPoints, assetTypes, prices };
}

type EventLedger = Awaited<ReturnType<typeof eventLedger>>;

/**
 * Each team's `teamAdjustments` input, by team id, from its lock record: the
 * locked and Late Call versions, the chip played and the transfer penalty, over
 * the ledger's sessions, points and prices.
 */
async function teamInputs(
  db: Db,
  ledger: EventLedger,
  eventId: string,
  states: (typeof teamEventStates.$inferSelect)[],
): Promise<Map<string, TeamEventInput>> {
  const versionIds = states.flatMap((s) =>
    s.finalFixVersionId === null
      ? [s.lockedVersionId]
      : [s.lockedVersionId, s.finalFixVersionId],
  );
  const picks = await versionPicks(db, versionIds, ledger.assetTypes);
  const finalFixFrom = new Map(
    (
      await db
        .select({
          id: lineupVersions.id,
          fromSessionId: lineupVersions.effectiveFromSessionId,
        })
        .from(lineupVersions)
        .where(inArray(lineupVersions.id, versionIds))
    ).map((v) => [v.id, v.fromSessionId]),
  );
  const chips = await playedChips(db, {
    eventId,
    teamIds: states.map((s) => s.teamId),
  });
  const inputs = new Map<string, TeamEventInput>();
  for (const state of states) {
    const chip = chips.get(state.teamId);
    if (state.chipPlayId !== (chip?.id ?? null)) {
      throw new Error(
        `scoring: team ${state.teamId}'s lock record names chip play ${state.chipPlayId}, but its played chip is ${chip?.id ?? "none"}`,
      );
    }
    inputs.set(state.teamId, {
      sessions: ledger.sessions,
      assetPoints: ledger.assetPoints,
      locked: picks.get(state.lockedVersionId) ?? [],
      finalFix:
        state.finalFixVersionId === null
          ? null
          : {
              picks: picks.get(state.finalFixVersionId) ?? [],
              fromSessionId: lateCallFrom(
                finalFixFrom,
                state.finalFixVersionId,
              ),
            },
      chip:
        chip && chip.effect !== null
          ? { effect: chip.effect, targetAssetId: chip.targetAssetId }
          : null,
      transferPenalty: state.transferPenalty,
      prices: ledger.prices,
    });
  }
  return inputs;
}

/** A team's event points: its base over the scored sessions plus its lines. */
function teamEventPoints(
  input: TeamEventInput,
  lines: AdjustmentLine[],
): number {
  let points = lines.reduce((sum, l) => sum + l.points, 0);
  for (const { sessionId } of input.sessions) {
    for (const pick of effectiveLineup(input, sessionId)) {
      points += input.assetPoints.get(sessionId)?.get(pick.assetId)?.total ?? 0;
    }
  }
  return points;
}

const teamChange = (id: string, before: number, after: number): Change => ({
  kind: "team",
  id,
  before,
  after,
  change: after - before,
});

/** Lines totalled as `asset_session_totals` totals them. */
function assetTotals(lines: AssetLine[]): Map<string, AssetSessionPoints> {
  const totals = new Map<string, AssetSessionPoints>();
  for (const { assetId, category, points } of lines) {
    const asset = totals.get(assetId) ?? { total: 0, byCategory: {} };
    asset.total += points;
    asset.byCategory[category] = (asset.byCategory[category] ?? 0) + points;
    totals.set(assetId, asset);
  }
  return totals;
}

/** The picks of each version, by version id, in asset id order. */
async function versionPicks(
  db: Db,
  versionIds: string[],
  assetTypes: Map<string, TeamPick["assetType"]>,
): Promise<Map<string, TeamPick[]>> {
  const byVersion = new Map<string, TeamPick[]>();
  for (const pick of await db
    .select()
    .from(lineupPicks)
    .where(inArray(lineupPicks.lineupVersionId, versionIds))
    .orderBy(asc(lineupPicks.assetId))) {
    const assetType = assetTypes.get(pick.assetId);
    if (assetType === undefined) {
      throw new Error(
        `scoring: picked asset ${pick.assetId} is not in the pool`,
      );
    }
    const list = byVersion.get(pick.lineupVersionId) ?? [];
    list.push({ assetId: pick.assetId, assetType, isBoost: pick.isBoost });
    byVersion.set(pick.lineupVersionId, list);
  }
  return byVersion;
}

function lineRow(
  run: LoadedRun,
  line: AssetLine,
): typeof assetScoreLines.$inferInsert {
  return {
    id: newId(),
    gameId: run.gameId,
    sessionId: run.sessionId,
    runId: run.id,
    assetId: line.assetId,
    ruleCode: line.ruleCode,
    category: line.category,
    subjectDriverId: line.subjectDriverId,
    points: line.points,
    detail: line.detail,
  };
}

/** The biggest changes first, then assets before teams, then by id. */
export function biggestOf(changes: Change[]): Change[] {
  return [...changes]
    .sort(
      (a, b) =>
        Math.abs(b.change) - Math.abs(a.change) ||
        byText(a.kind, b.kind) ||
        byText(a.id, b.id),
    )
    .slice(0, BIGGEST);
}

function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    yield rows.slice(i, i + INSERT_CHUNK);
  }
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
