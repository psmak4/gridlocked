import type { SCORING_RUN_TRIGGERS } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  finishRun,
  startRun,
  writeAssetLines,
  writeTeamAdjustments,
} from "@/game/scoring-runs";

/**
 * A whole live run for the session, every step in turn as the job runs them:
 * the asset lines, then every locked team's adjustments in batches, then the
 * finish. Returns the run's id, and throws when the run is skipped (the same
 * inputs as the current run) or superseded.
 */
export async function scoreWholeSession(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    sessionId: string;
    trigger?: (typeof SCORING_RUN_TRIGGERS)[number];
  },
): Promise<string> {
  const started = await startRun(db, now, {
    gameId: input.gameId,
    sessionId: input.sessionId,
    trigger: input.trigger ?? "results",
    mode: "live",
  });
  if (!("runId" in started)) throw new Error("the run was skipped");
  const { runId } = started;
  if ((await writeAssetLines(db, now, runId)) !== "written") {
    throw new Error(`run ${runId} superseded`);
  }
  let afterTeamId: string | null = null;
  for (;;) {
    const batch = await writeTeamAdjustments(db, now, runId, { afterTeamId });
    if (batch === "superseded") throw new Error(`run ${runId} superseded`);
    if (batch.done) break;
    afterTeamId = batch.lastTeamId;
  }
  await finishRun(db, now, runId);
  return runId;
}
